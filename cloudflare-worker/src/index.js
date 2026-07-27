/**
 * Cloudflare Worker — Firebase Functions replacement
 *
 * Implements the same 4 functions as functions/index.js, using only
 * free-tier Cloudflare Workers (no Firebase Blaze plan required).
 *
 * Protocol: Firebase callable function HTTP format
 *   POST /{functionName}
 *   Body:     { "data": { ... } }
 *   Auth:     Authorization: Bearer {firebaseIdToken}   (when caller is signed in)
 *   Success:  { "result": { ... } }
 *   Error:    { "error": { "status": "INVALID_ARGUMENT", "message": "..." } }
 *
 * Required Worker secrets (set via: wrangler secret put <NAME>):
 *   FIREBASE_PRIVATE_KEY   — PEM private key from service account JSON
 *   FIREBASE_CLIENT_EMAIL  — client_email from service account JSON
 *   ADMIN_PIN              — operator PIN (e.g. "1414")
 *
 * Required Worker var (wrangler.toml [vars]):
 *   FIREBASE_PROJECT_ID    — billing-system-f8531
 */

// ── App constants ──────────────────────────────────────────────────────────────
const REQUIRE_PHONE_VERIFICATION = false;   // flip to true when OTP/DLT approved
const OPERATOR_UID               = 'billing-operator-main';

// ── Error ──────────────────────────────────────────────────────────────────────
class FnError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const CODE_TO_HTTP = {
  'ok': 200, 'cancelled': 499, 'unknown': 500,
  'invalid-argument': 400, 'deadline-exceeded': 504,
  'not-found': 404, 'already-exists': 409, 'permission-denied': 403,
  'resource-exhausted': 429, 'failed-precondition': 400, 'aborted': 409,
  'out-of-range': 400, 'unimplemented': 501, 'internal': 500,
  'unavailable': 503, 'data-loss': 500, 'unauthenticated': 401,
};
const CODE_TO_STATUS = {
  'ok': 'OK', 'cancelled': 'CANCELLED', 'unknown': 'UNKNOWN',
  'invalid-argument': 'INVALID_ARGUMENT', 'deadline-exceeded': 'DEADLINE_EXCEEDED',
  'not-found': 'NOT_FOUND', 'already-exists': 'ALREADY_EXISTS',
  'permission-denied': 'PERMISSION_DENIED', 'resource-exhausted': 'RESOURCE_EXHAUSTED',
  'failed-precondition': 'FAILED_PRECONDITION', 'aborted': 'ABORTED',
  'out-of-range': 'OUT_OF_RANGE', 'unimplemented': 'UNIMPLEMENTED',
  'internal': 'INTERNAL', 'unavailable': 'UNAVAILABLE',
  'data-loss': 'DATA_LOSS', 'unauthenticated': 'UNAUTHENTICATED',
};

// ── CORS ───────────────────────────────────────────────────────────────────────
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Firebase-Client, X-Goog-Api-Client',
    'Access-Control-Max-Age':       '3600',
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function errorResponse(code, message) {
  return jsonResponse(
    { error: { status: CODE_TO_STATUS[code] || 'INTERNAL', message } },
    CODE_TO_HTTP[code] || 500,
  );
}

// ── Base64url helpers ──────────────────────────────────────────────────────────
function base64urlEncode(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    bytes = input;
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return base64urlDecode(b64.replace(/\+/g, '-').replace(/\//g, '_'));
}

// ── JWT signing (RS256 with service account private key) ───────────────────────
let _cachedPrivKey = null;

async function getPrivateKey(pemKey) {
  if (_cachedPrivKey) return _cachedPrivKey;
  const der = pemToDer(pemKey);
  _cachedPrivKey = await crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
  return _cachedPrivKey;
}

async function signJwt(payload, env) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const h = base64urlEncode(JSON.stringify(header));
  const p = base64urlEncode(JSON.stringify(payload));
  const key = await getPrivateKey(env.FIREBASE_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', key,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${base64urlEncode(sig)}`;
}

// ── Service account OAuth2 access token ───────────────────────────────────────
let _accessToken = null;
let _accessTokenExp = 0;

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_accessToken && now < _accessTokenExp - 60) return _accessToken;

  const jwt = await signJwt({
    iss:   env.FIREBASE_CLIENT_EMAIL,
    sub:   env.FIREBASE_CLIENT_EMAIL,
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase',
  }, env);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new FnError('internal', `Failed to obtain access token: ${JSON.stringify(data)}`);
  }
  _accessToken    = data.access_token;
  _accessTokenExp = now + (data.expires_in || 3600);
  return _accessToken;
}

// ── Firebase custom token ──────────────────────────────────────────────────────
async function createCustomToken(uid, claims, env) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    iss:    env.FIREBASE_CLIENT_EMAIL,
    sub:    env.FIREBASE_CLIENT_EMAIL,
    aud:    'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat:    now,
    exp:    now + 3600,
    uid,
    claims: claims || {},
  }, env);
}

// ── Firebase ID token verification ────────────────────────────────────────────
// Verifies tokens issued by Firebase Auth (after signInWithCustomToken).
// Caches public keys for performance.
let _pubKeyCache = null;
let _pubKeyCacheExp = 0;

function extractSpkiFromX509Der(derBuffer) {
  // Minimal ASN.1 DER walker to find SubjectPublicKeyInfo
  const der = new Uint8Array(derBuffer);

  function readLen(pos) {
    const b = der[pos];
    if (b < 0x80) return { len: b, next: pos + 1 };
    const nb = b & 0x7f;
    let len = 0;
    for (let i = 0; i < nb; i++) len = (len << 8) | der[pos + 1 + i];
    return { len, next: pos + 1 + nb };
  }

  // Walk: Certificate → TBSCertificate → find SPKI SEQUENCE
  // Certificate outer SEQUENCE
  let pos = 1; // skip 0x30 tag
  const { len: certLen, next: certContent } = readLen(pos);

  // TBSCertificate is first child
  pos = certContent + 1; // skip TBS SEQUENCE tag
  const { next: tbsContent } = readLen(pos);

  // Walk TBSCertificate children looking for SubjectPublicKeyInfo
  // SPKI is a SEQUENCE { AlgorithmIdentifier(SEQUENCE), BIT STRING }
  // AlgorithmIdentifier contains the RSA OID
  const RSA_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
  pos = tbsContent;

  while (pos < der.length - 20) {
    if (der[pos] !== 0x30) { pos++; continue; }
    const { len: seqLen, next: seqContent } = readLen(pos + 1);
    const seqEnd = seqContent + seqLen;

    // Check if this SEQUENCE starts with an OID SEQUENCE containing the RSA OID
    if (der[seqContent] === 0x30) {
      const { len: algLen, next: algContent } = readLen(seqContent + 1);
      if (der[algContent] === 0x06) {
        const { len: oidLen, next: oidContent } = readLen(algContent + 1);
        if (oidLen === RSA_OID.length) {
          let match = true;
          for (let i = 0; i < RSA_OID.length; i++) {
            if (der[oidContent + i] !== RSA_OID[i]) { match = false; break; }
          }
          if (match && seqEnd <= der.length) {
            return der.slice(pos, seqEnd).buffer;
          }
        }
      }
    }
    pos = seqEnd;
  }
  throw new Error('SubjectPublicKeyInfo not found in X.509 certificate');
}

async function getFirebasePublicKeys() {
  const now = Math.floor(Date.now() / 1000);
  if (_pubKeyCache && now < _pubKeyCacheExp) return _pubKeyCache;

  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com',
  );
  // Cache-Control header tells us how long these keys are valid
  const cc = res.headers.get('Cache-Control') || '';
  const maxAge = parseInt((cc.match(/max-age=(\d+)/) || [])[1] || '3600', 10);

  const certs = await res.json();
  const keys = {};
  for (const [kid, pem] of Object.entries(certs)) {
    const der = pemToDer(pem);
    const spki = extractSpkiFromX509Der(der);
    keys[kid] = await crypto.subtle.importKey(
      'spki', spki,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify'],
    );
  }
  _pubKeyCache    = keys;
  _pubKeyCacheExp = now + maxAge;
  return keys;
}

async function verifyIdToken(idToken, projectId) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new FnError('unauthenticated', 'Malformed ID token.');

  const header  = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
  const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));

  const now = Math.floor(Date.now() / 1000);
  if (!payload.sub)                     throw new FnError('unauthenticated', 'Token missing sub.');
  if (payload.exp < now)                throw new FnError('unauthenticated', 'Token expired.');
  if (payload.iat > now + 300)          throw new FnError('unauthenticated', 'Token issued in the future.');
  if (payload.aud !== projectId)        throw new FnError('unauthenticated', 'Token audience mismatch.');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`)
                                        throw new FnError('unauthenticated', 'Token issuer mismatch.');

  const keys = await getFirebasePublicKeys();
  const key  = keys[header.kid];
  if (!key) throw new FnError('unauthenticated', `Unknown key ID: ${header.kid}`);

  const sigInput = `${parts[0]}.${parts[1]}`;
  const sigBytes = base64urlDecode(parts[2]);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key,
    sigBytes,
    new TextEncoder().encode(sigInput),
  );
  if (!valid) throw new FnError('unauthenticated', 'Invalid token signature.');

  return {
    uid:   payload.sub,
    token: payload,   // full claims including custom claims
  };
}

// ── Firestore REST helpers ────────────────────────────────────────────────────
function toFsValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean')          return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val)
      ? { integerValue: String(val) }
      : { doubleValue: val };
  }
  if (typeof val === 'string')           return { stringValue: val };
  if (val instanceof Date)               return { timestampValue: val.toISOString() };
  if (Array.isArray(val))                return { arrayValue: { values: val.map(toFsValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = toFsValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFsValue(v) {
  if (!v) return null;
  if ('nullValue'      in v) return null;
  if ('booleanValue'   in v) return v.booleanValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return v.doubleValue;
  if ('stringValue'    in v) return v.stringValue;
  if ('timestampValue' in v) return v.timestampValue;  // keep as string
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ('mapValue'       in v) {
    const out = {};
    for (const [k, fv] of Object.entries(v.mapValue.fields || {})) out[k] = fromFsValue(fv);
    return out;
  }
  return null;
}

function docToJs(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) out[k] = fromFsValue(v);
  return out;
}

function jsToFields(obj, serverTimestampFields = []) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!serverTimestampFields.includes(k)) fields[k] = toFsValue(v);
  }
  return fields;
}

function serverTimestampTransform(fieldPath) {
  return { fieldPath, setToServerValue: 'REQUEST_TIME' };
}

class Firestore {
  constructor(env, projectId) {
    this.base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    this.env  = env;
    this._projectId = projectId;
  }

  docPath(collection, docId) {
    return `projects/${this._projectId}/databases/(default)/documents/${collection}/${docId}`;
  }

  async _token() { return getAccessToken(this.env); }

  async get(collection, docId) {
    const tok = await this._token();
    const res = await fetch(`${this.base}/${collection}/${docId}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (res.status === 404) return { exists: false, data: null };
    if (!res.ok) throw new FnError('internal', `Firestore GET failed: ${res.status} ${await res.text()}`);
    const doc = await res.json();
    return { exists: true, data: docToJs(doc), ref: doc.name };
  }

  async set(collection, docId, jsObj, serverTsFields = []) {
    const tok = await this._token();
    const body = { fields: jsToFields(jsObj, serverTsFields) };
    // Use PATCH without updateMask to overwrite (equivalent to set())
    const url = `${this.base}/${collection}/${docId}`;
    const writes = [{
      update: { name: this.docPath(collection, docId), fields: body.fields },
      ...(serverTsFields.length ? { updateTransforms: serverTsFields.map(serverTimestampTransform) } : {}),
    }];
    return this._commit(writes);
  }

  async update(collection, docId, jsObj, serverTsFields = []) {
    const fields = jsToFields(jsObj, serverTsFields);
    const fieldPaths = Object.keys(fields);
    const writes = [{
      update: {
        name:   this.docPath(collection, docId),
        fields,
      },
      updateMask: { fieldPaths },
      ...(serverTsFields.length ? { updateTransforms: serverTsFields.map(serverTimestampTransform) } : {}),
    }];
    return this._commit(writes);
  }

  async merge(collection, docId, jsObj, serverTsFields = []) {
    // Like set({ merge: true }) — only touch specified fields
    const fields = jsToFields(jsObj, serverTsFields);
    const writes = [{
      update: { name: this.docPath(collection, docId), fields },
      updateMask: { fieldPaths: Object.keys(fields) },
      ...(serverTsFields.length ? { updateTransforms: serverTsFields.map(serverTimestampTransform) } : {}),
    }];
    return this._commit(writes);
  }

  async query(collection, conditions) {
    // conditions: [{ field, op, value }]  op = '==' only for simplicity
    const tok   = await this._token();
    const where = conditions.length === 1
      ? {
          fieldFilter: {
            field: { fieldPath: conditions[0].field },
            op:    'EQUAL',
            value: toFsValue(conditions[0].value),
          },
        }
      : {
          compositeFilter: {
            op: 'AND',
            filters: conditions.map(c => ({
              fieldFilter: {
                field: { fieldPath: c.field },
                op:    'EQUAL',
                value: toFsValue(c.value),
              },
            })),
          },
        };

    const res = await fetch(`${this.base}:runQuery`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: collection }],
          where,
          limit: 100,
        },
      }),
    });
    if (!res.ok) throw new FnError('internal', `Firestore query failed: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    return rows
      .filter(r => r.document)
      .map(r => ({
        exists: true,
        id:     r.document.name.split('/').pop(),
        ref:    r.document.name,
        data:   docToJs(r.document),
      }));
  }

  async runTransaction(txFn) {
    const tok = await this._token();

    // Begin transaction
    const txRes = await fetch(`${this.base}:beginTransaction`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ options: { readWrite: {} } }),
    });
    if (!txRes.ok) throw new FnError('internal', `beginTransaction failed: ${txRes.status}`);
    const { transaction: txId } = await txRes.json();

    // batchGet helper for the transaction
    const batchGet = async (docPaths) => {
      const bgRes = await fetch(`${this.base}:batchGet`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documents:   docPaths.map(p => `projects/${this._projectId}/databases/(default)/documents/${p}`),
          transaction: txId,
        }),
      });
      if (!bgRes.ok) throw new FnError('internal', `batchGet failed: ${bgRes.status}`);
      const results = await bgRes.json();
      const map = {};
      for (const r of results) {
        if (r.found) {
          const shortPath = r.found.name.replace(`projects/${this._projectId}/databases/(default)/documents/`, '');
          map[shortPath] = { exists: true, data: docToJs(r.found) };
        } else if (r.missing) {
          const shortPath = r.missing.replace(`projects/${this._projectId}/databases/(default)/documents/`, '');
          map[shortPath] = { exists: false, data: null };
        }
      }
      return map;
    };

    // Collect writes
    const writes = [];
    const txContext = {
      batchGet,
      set: (collection, docId, jsObj, serverTsFields = []) => {
        writes.push({
          update: {
            name:   `projects/${this._projectId}/databases/(default)/documents/${collection}/${docId}`,
            fields: jsToFields(jsObj, serverTsFields),
          },
          ...(serverTsFields.length ? { updateTransforms: serverTsFields.map(serverTimestampTransform) } : {}),
        });
      },
      update: (collection, docId, jsObj, serverTsFields = []) => {
        const fields = jsToFields(jsObj, serverTsFields);
        writes.push({
          update: {
            name: `projects/${this._projectId}/databases/(default)/documents/${collection}/${docId}`,
            fields,
          },
          updateMask: { fieldPaths: Object.keys(fields) },
          ...(serverTsFields.length ? { updateTransforms: serverTsFields.map(serverTimestampTransform) } : {}),
        });
      },
      merge: (collection, docId, jsObj, serverTsFields = []) => {
        const fields = jsToFields(jsObj, serverTsFields);
        writes.push({
          update: {
            name: `projects/${this._projectId}/databases/(default)/documents/${collection}/${docId}`,
            fields,
          },
          updateMask: { fieldPaths: Object.keys(fields).concat(serverTsFields) },
          ...(serverTsFields.length ? { updateTransforms: serverTsFields.map(serverTimestampTransform) } : {}),
        });
      },
      setIfNotExists: (collection, docId, jsObj, serverTsFields = []) => {
        writes.push({
          update: {
            name:   `projects/${this._projectId}/databases/(default)/documents/${collection}/${docId}`,
            fields: jsToFields(jsObj, serverTsFields),
          },
          currentDocument: { exists: false },
          ...(serverTsFields.length ? { updateTransforms: serverTsFields.map(serverTimestampTransform) } : {}),
        });
      },
      deleteDoc: (collection, docId) => {
        writes.push({ delete: `projects/${this._projectId}/databases/(default)/documents/${collection}/${docId}` });
      },
    };

    const result = await txFn(txContext);

    // Commit
    const commitRes = await fetch(`${this.base}:commit`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ transaction: txId, writes }),
    });
    if (!commitRes.ok) {
      const errText = await commitRes.text();
      throw new FnError('aborted', `Transaction commit failed: ${commitRes.status} ${errText}`);
    }
    return result;
  }

  async _commit(writes) {
    const tok = await this._token();
    const res = await fetch(`${this.base}:commit`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ writes }),
    });
    if (!res.ok) throw new FnError('internal', `Firestore commit failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
}

// ── Firebase Auth REST helpers ─────────────────────────────────────────────────
class FirebaseAuth {
  constructor(env, projectId) {
    this.base    = `https://identitytoolkit.googleapis.com/v1/projects/${projectId}`;
    this.env     = env;
  }

  async _token() { return getAccessToken(this.env); }

  async getUser(uid) {
    const tok = await this._token();
    const res = await fetch(`${this.base}/accounts:lookup`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ localId: [uid] }),
    });
    if (!res.ok) throw new FnError('internal', `Auth getUser failed: ${res.status}`);
    const data = await res.json();
    if (!data.users || data.users.length === 0) {
      const err = new FnError('internal', 'User not found');
      err.authCode = 'auth/user-not-found';
      throw err;
    }
    return data.users[0];
  }

  async ensureUser(uid, displayName) {
    try {
      await this.getUser(uid);
      console.log(`[ensureUser] existing: ${uid}`);
    } catch (e) {
      if (e.authCode === 'auth/user-not-found') {
        const tok = await this._token();
        const res = await fetch(`${this.base}/accounts`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ localId: uid, displayName: displayName || '' }),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          // Ignore DUPLICATE_LOCAL_ID — race condition, user was created concurrently
          if (errData?.error?.message !== 'DUPLICATE_LOCAL_ID') {
            throw new FnError('internal', `Auth createUser failed: ${res.status} ${JSON.stringify(errData)}`);
          }
        }
        console.log(`[ensureUser] created: ${uid}`);
      } else {
        throw e;
      }
    }
  }

  async setCustomClaims(uid, claims) {
    const tok = await this._token();
    const res = await fetch(`${this.base}/accounts:update`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ localId: uid, customAttributes: JSON.stringify(claims) }),
    });
    if (!res.ok) throw new FnError('internal', `setCustomClaims failed: ${res.status} ${await res.text()}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') throw new FnError('invalid-argument', 'Phone number is required.');
  let s = raw.trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^0\d{10}$/.test(s))  s = '+91' + s.slice(1);
  if (/^\d{10}$/.test(s))   s = '+91' + s;
  if (/^91\d{10}$/.test(s)) s = '+' + s;
  if (!/^\+\d{10,15}$/.test(s)) {
    throw new FnError('invalid-argument', `Invalid phone number: "${raw}". Use format +91XXXXXXXXXX.`);
  }
  return s;
}

function customerUidFromPhone(phone) {
  return 'cust_' + phone.replace(/^\+/, '');
}

// ── operatorSignIn ─────────────────────────────────────────────────────────────
async function handleOperatorSignIn(data, db, fbAuth, env) {
  const { pin } = data || {};
  if (!pin || pin !== env.ADMIN_PIN) {
    throw new FnError('unauthenticated', 'Invalid PIN.');
  }

  // Ensure operator account exists with billingOperator claim
  await fbAuth.ensureUser(OPERATOR_UID, 'Billing Operator');
  await fbAuth.setCustomClaims(OPERATOR_UID, { billingOperator: true });

  const token = await createCustomToken(OPERATOR_UID, { billingOperator: true }, env);
  return { token };
}

// ── customerAuth ──────────────────────────────────────────────────────────────
async function handleCustomerAuth(data, db, fbAuth, env) {
  const { action, phone: rawPhone, name: rawName } = data || {};

  if (!action || !['lookup', 'create'].includes(action)) {
    throw new FnError('invalid-argument', "action must be 'lookup' or 'create'.");
  }

  const phone = normalizePhone(rawPhone);
  const uid   = customerUidFromPhone(phone);
  console.log(`[customerAuth] action=${action} phone=${phone} uid=${uid}`);

  // ── lookup ───────────────────────────────────────────────────────────────────
  if (action === 'lookup') {
    const snap = await db.get('customers', phone);
    if (!snap.exists) {
      return { found: false, phone };
    }
    const profile = snap.data;

    // Backfill non-destructively
    const backfill = {};
    if (!profile.authUid)                    backfill.authUid = uid;
    if (profile.phoneVerified === undefined) backfill.phoneVerified = false;

    // Non-fatal: update lastLoginAt + backfill
    db.update('customers', phone,
      { lastLoginAt: null, ...backfill },
      ['lastLoginAt'],
    ).catch(e => console.warn('[customerAuth:lookup] profile update failed:', e));

    db.merge('customer_uid_map', uid,
      { phone },
      ['updatedAt'],
    ).catch(e => console.warn('[customerAuth:lookup] uidMapRef failed:', e));

    await fbAuth.ensureUser(uid, profile.name || '');

    let token;
    try {
      token = await createCustomToken(uid, { customerPhone: phone }, env);
    } catch (e) {
      throw new FnError('internal', `Custom token creation failed: ${e.message}. Ensure service account has Token Creator role.`);
    }

    return { found: true, name: profile.name || '', phone: profile.phone || phone, token };
  }

  // ── create ───────────────────────────────────────────────────────────────────
  if (action === 'create') {
    const name = (rawName || '').trim();
    if (!name) throw new FnError('invalid-argument', 'Customer name is required.');

    const snap = await db.get('customers', phone);

    if (snap.exists) {
      // Race condition — profile already exists, treat as lookup
      const profile = snap.data;
      const backfill = {};
      if (!profile.authUid)                    backfill.authUid = uid;
      if (profile.phoneVerified === undefined) backfill.phoneVerified = false;
      db.update('customers', phone, { lastLoginAt: null, ...backfill }, ['lastLoginAt'])
        .catch(e => console.warn('[customerAuth:create] profile update non-fatal:', e));
      db.merge('customer_uid_map', uid, { phone }, ['updatedAt'])
        .catch(e => console.warn('[customerAuth:create] uidMap non-fatal:', e));
      await fbAuth.ensureUser(uid, profile.name || name);
      const token = await createCustomToken(uid, { customerPhone: phone }, env);
      return { found: true, name: profile.name || name, phone: profile.phone || phone, token, uid };
    }

    // New customer
    await Promise.all([
      db.set('customers', phone, {
        phone, name, phoneVerified: false, authUid: uid,
      }, ['createdAt', 'updatedAt', 'lastLoginAt']),
      db.set('customer_uid_map', uid, { phone }, ['createdAt']),
    ]);

    await fbAuth.ensureUser(uid, name);

    const token = await createCustomToken(uid, { customerPhone: phone }, env);
    return { token, uid, name, phone };
  }
}

// ── createCustomerOrder ───────────────────────────────────────────────────────
async function handleCreateCustomerOrder(data, authCtx, db, fbAuth, env) {
  if (!authCtx?.uid) throw new FnError('unauthenticated', 'Customer must be signed in with Firebase Auth.');

  const customerUid   = authCtx.uid;
  const customerPhone = authCtx.token?.customerPhone || '';
  if (!customerPhone) {
    throw new FnError('unauthenticated', 'Session not established via customerAuth. Please sign in through customer login.');
  }

  const profileSnap = await db.get('customers', customerPhone);
  if (!profileSnap.exists) {
    throw new FnError('not-found', 'Customer profile not found. Please complete registration.');
  }
  const profile = profileSnap.data;

  if (REQUIRE_PHONE_VERIFICATION && profile.phoneVerified !== true) {
    throw new FnError('permission-denied', 'Phone verification required to place orders.');
  }

  const customerName = profile.name || '';
  const { requestedTableId, items = [] } = data || {};

  if (!requestedTableId || typeof requestedTableId !== 'string') {
    throw new FnError('invalid-argument', 'requestedTableId is required.');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new FnError('invalid-argument', 'items must be a non-empty array.');
  }

  const result = await db.runTransaction(async (tx) => {
    const docs = await tx.batchGet([
      `table_locks/${requestedTableId}`,
      `customer_table_sessions/${customerUid}`,
    ]);

    const existingTableLock = docs[`table_locks/${requestedTableId}`];
    const existingSession   = docs[`customer_table_sessions/${customerUid}`];

    let assignedTableId, lockId, isNewLock = false;

    if (existingSession?.exists && existingSession.data?.lockStatus === 'active') {
      assignedTableId = existingSession.data.activeTableId;
      lockId          = existingSession.data.lockId;
    } else if (existingTableLock?.exists && existingTableLock.data?.status === 'active') {
      if (existingTableLock.data.customerUid !== customerUid) {
        throw new FnError('already-exists', `Table "${requestedTableId}" is occupied by another customer.`);
      }
      assignedTableId = requestedTableId;
      lockId          = existingTableLock.data.lockId;
    } else {
      assignedTableId = requestedTableId;
      lockId          = `lock_${customerUid}_${Date.now()}`;
      isNewLock       = true;
      tx.set('table_locks', requestedTableId, {
        customerUid, lockId, status: 'active',
      }, ['lockedAt']);
    }

    const orderId    = `ORD_${Date.now()}_${customerUid.slice(0, 10)}`;
    const totalPrice = items.reduce((s, i) => s + (Number(i.price) * (Number(i.quantity) || 1)), 0);

    tx.set('pending_table_orders', orderId, {
      tableId:         assignedTableId,
      customer:        { uid: customerUid, name: customerName, phone: customerPhone },
      customerSessionId: customerUid,
      tableLockId:     lockId,
      status:          'pending',
      items,
      totalPrice,
    }, ['createdAt']);

    const prevOrderIds  = existingSession?.exists ? (existingSession.data.activeOrderIds || []) : [];
    const newOrderIds   = [...prevOrderIds, orderId];
    const sessionData   = {
      customerUid,
      phone:          customerPhone,
      activeTableId:  assignedTableId,
      lockStatus:     'active',
      lockId,
      activeOrderIds: newOrderIds,
      releasedAt:     null,
    };
    if (isNewLock) {
      tx.merge('customer_table_sessions', customerUid, sessionData, ['lockedAt']);
    } else {
      tx.merge('customer_table_sessions', customerUid, sessionData);
    }

    return { orderId, tableId: assignedTableId, sessionId: customerUid, lockId };
  });

  // Non-critical: update lastLoginAt
  db.update('customers', customerPhone, { lastLoginAt: null }, ['lastLoginAt'])
    .catch(e => console.warn('[createCustomerOrder] lastLoginAt update:', e));

  return result;
}

// ── releaseTableLock ──────────────────────────────────────────────────────────
async function handleReleaseTableLock(data, authCtx, db, fbAuth, env) {
  if (!authCtx?.uid) throw new FnError('unauthenticated', 'Caller must be authenticated.');
  if (!authCtx.token?.billingOperator) {
    throw new FnError('permission-denied', 'Caller is not an authorized billing operator.');
  }

  const { tableId, releaseReason } = data || {};
  if (!tableId) throw new FnError('invalid-argument', 'tableId is required.');
  const valid = ['bill_settle', 'save_exit'];
  if (!valid.includes(releaseReason)) {
    throw new FnError('invalid-argument', `releaseReason must be one of: ${valid.join(', ')}`);
  }

  const sessions = await db.query('customer_table_sessions', [
    { field: 'activeTableId', op: '==', value: tableId },
    { field: 'lockStatus',    op: '==', value: 'active' },
  ]);

  if (sessions.length === 0) {
    return { released: false, reason: 'no_active_session' };
  }

  const sess     = sessions[0];
  const orderIds = Array.isArray(sess.data.activeOrderIds) ? sess.data.activeOrderIds : [];

  await db.runTransaction(async (tx) => {
    // Fetch all active order docs
    const orderPaths = orderIds.map(id => `pending_table_orders/${id}`);
    const orderDocs  = orderIds.length > 0 ? await tx.batchGet(orderPaths) : {};

    for (const orderId of orderIds) {
      const snap = orderDocs[`pending_table_orders/${orderId}`];
      if (snap?.exists) {
        const st = (snap.data.status || 'pending').toLowerCase();
        if (['pending', 'accepted', 'kot'].includes(st)) {
          tx.update('pending_table_orders', orderId, { status: 'completed' });
        }
      }
    }

    tx.update('customer_table_sessions', sess.id, {
      lockStatus:     'released',
      activeTableId:  null,
      activeOrderIds: [],
      releaseReason,
    }, ['releasedAt']);

    tx.set('table_locks', tableId, {
      customerUid: null,
      lockId:      null,
      status:      'released',
    }, ['releasedAt']);
  });

  console.log(`[releaseTableLock] Released "${tableId}", reason: ${releaseReason}`);
  return { released: true, tableId, releaseReason };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(JSON.stringify({ ok: true, service: 'pizza-billing-functions' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      });
    }

    if (request.method !== 'POST') {
      return errorResponse('unimplemented', 'Only POST is supported.');
    }

    const fnName = url.pathname.replace(/^\//, '').split('/')[0];

    let body;
    try {
      body = await request.json();
    } catch {
      return errorResponse('invalid-argument', 'Request body must be valid JSON.');
    }

    const data        = body?.data ?? {};
    const authHeader  = request.headers.get('Authorization') || '';
    const rawToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const projectId   = env.FIREBASE_PROJECT_ID || 'billing-system-f8531';

    const db     = new Firestore(env, projectId);
    const fbAuth = new FirebaseAuth(env, projectId);

    try {
      let result;

      switch (fnName) {
        case 'operatorSignIn':
          result = await handleOperatorSignIn(data, db, fbAuth, env);
          break;

        case 'customerAuth':
          result = await handleCustomerAuth(data, db, fbAuth, env);
          break;

        case 'createCustomerOrder': {
          if (!rawToken) throw new FnError('unauthenticated', 'Customer must be signed in with Firebase Auth.');
          const authCtx = await verifyIdToken(rawToken, projectId);
          result = await handleCreateCustomerOrder(data, authCtx, db, fbAuth, env);
          break;
        }

        case 'releaseTableLock': {
          if (!rawToken) throw new FnError('unauthenticated', 'Caller must be authenticated.');
          const authCtx = await verifyIdToken(rawToken, projectId);
          result = await handleReleaseTableLock(data, authCtx, db, fbAuth, env);
          break;
        }

        default:
          return errorResponse('not-found', `Function "${fnName}" not found.`);
      }

      return jsonResponse({ result });

    } catch (e) {
      if (e instanceof FnError) {
        console.error(`[${fnName}] FnError ${e.code}: ${e.message}`);
        return errorResponse(e.code, e.message);
      }
      console.error(`[${fnName}] Unhandled:`, e.message, e.stack);
      return errorResponse('internal', e.message || 'Internal error');
    }
  },
};

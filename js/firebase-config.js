import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import {
    initializeFirestore,
    persistentLocalCache,
    persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-functions.js";

const firebaseConfig = {
    apiKey: "AIzaSyBLzGd0DlItKShk0eJoQR4CjRx1sP3-o-w",
    authDomain: "billing-system-f8531.firebaseapp.com",
    projectId: "billing-system-f8531",
    storageBucket: "billing-system-f8531.firebasestorage.app",
    messagingSenderId: "921228841270",
    appId: "1:921228841270:web:9013d59b3ef96dda40e397",
    measurementId: "G-JMPEJCCBHZ"
};

const app = initializeApp(firebaseConfig);

// Enable IndexedDB offline persistence — data survives app close/reopen
// Multi-tab manager so multiple browser tabs don't conflict
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager()
    })
});

export const storage = getStorage(app);

// Firebase Auth — persists operator session automatically in IndexedDB
export const auth = getAuth(app);

// Firebase Functions — routed through Cloudflare Worker (free tier, no Blaze plan required)
export const functions = getFunctions(app, 'asia-south1');
functions.customDomain = 'https://young-moon-f3b7.realarnavm.workers.dev';

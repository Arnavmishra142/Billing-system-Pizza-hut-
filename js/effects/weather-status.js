// js/effects/weather-status.js — Admin Panel "Live Status" helpers
// [AI UPDATE 2026-09-25] NEW FILE.
//
// Two small PURE functions, copied on purpose (not imported cross-repo, since
// the Admin and Customer Panels are separate deployments/repos):
//   - normalizeWeather()   — identical to the Customer Panel's
//     js/effects/weather-normalizer.js
//   - resolveActiveEffect() — identical to the Customer Panel's
//     js/effects/effect-resolver.js
//
// WHY duplicated instead of shared: the Customer Panel resolves what EFFECT
// the customer sees; the Admin Panel only needs to PREDICT that same result
// (from the same two inputs — the live settings/seasonal_effects config and a
// live OpenWeather reading) so the "Live Status" card in js/effects-admin.js
// can honestly show the operator "this is what your customers are seeing
// right now" without depending on the Customer Panel's deployment being up.
//
// ⚠️ KEEP IN SYNC: if either function's LOGIC changes in the Customer Panel
// repo (js/effects/weather-normalizer.js or js/effects/effect-resolver.js),
// copy the change here too, or the Admin Panel's "Live Status" card can show
// a prediction that quietly disagrees with what customers actually see.

// id ranges per OpenWeather's documented groups:
//  2xx Thunderstorm · 3xx Drizzle · 5xx Rain · 6xx Snow · 7xx Atmosphere · 800 Clear · 80x Clouds
export function normalizeWeather({ condId, main, icon } = {}) {
  const isNight = typeof icon === "string" && icon.endsWith("n");
  const id = typeof condId === "number" ? condId : null;

  if (id !== null && id >= 200 && id < 300) return { effect: "rain", variant: "thunderstorm", isNight };
  if (id !== null && id >= 300 && id < 400) return { effect: "rain", variant: "drizzle", isNight };

  if (id !== null && id >= 500 && id < 600) {
    let variant = "moderate";
    if (id === 500 || id === 520) variant = "light";
    else if (id === 501 || id === 521) variant = "moderate";
    else if (id === 502 || id === 503 || id === 522) variant = "heavy";
    else if (id === 504 || id === 531) variant = "extreme";
    else if (id === 511) variant = "freezing";
    return { effect: "rain", variant, isNight };
  }

  if (id !== null && id >= 600 && id < 700) {
    let variant = "moderate";
    if (id === 600 || id === 620) variant = "light";
    else if (id === 602 || id === 622) variant = "heavy";
    else if (id >= 611 && id <= 616) variant = "sleet";
    return { effect: "snow", variant, isNight };
  }

  if (id !== null && id >= 700 && id < 800) {
    if (id === 731 || id === 761) return { effect: "fog", variant: "dust", isNight };
    if (id === 751) return { effect: "fog", variant: "sand", isNight };
    if (id === 762) return { effect: "fog", variant: "ash", isNight };
    if (id === 711) return { effect: "fog", variant: "smoke", isNight };
    if (id === 721) return { effect: "fog", variant: "haze", isNight };
    if (id === 701) return { effect: "fog", variant: "mist", isNight };
    if (id === 741) return { effect: "fog", variant: "fog", isNight };
    if (id === 771 || id === 781) return { effect: "cloudy", variant: "storm", isNight };
    return { effect: "fog", variant: "mist", isNight };
  }

  if (id === 800) return { effect: "sunny", variant: "clear", isNight };

  if (id !== null && id > 800 && id < 900) {
    let variant = "scattered";
    if (id === 801) variant = "few";
    else if (id === 802) variant = "scattered";
    else if (id === 803) variant = "broken";
    else if (id === 804) variant = "overcast";
    return { effect: "cloudy", variant, isNight };
  }

  const m = (main || "").toLowerCase();
  if (m.includes("rain") || m.includes("drizzle")) return { effect: "rain", variant: "moderate", isNight };
  if (m.includes("thunder")) return { effect: "rain", variant: "thunderstorm", isNight };
  if (m.includes("snow")) return { effect: "snow", variant: "moderate", isNight };
  if (m.includes("cloud")) return { effect: "cloudy", variant: "scattered", isNight };
  if (m) return { effect: "fog", variant: "mist", isNight };
  return { effect: "sunny", variant: "clear", isNight };
}

// Priority (must match js/effects/effect-resolver.js in the Customer Panel):
//   1. effectsEnabled === false         -> no effect, overrides everything
//   2. manualEffectId set               -> that exact effect, overrides weather
//   3. automaticWeatherEnabled === true -> weather-mapped effect
//   4. otherwise                        -> no effect
export function resolveActiveEffect(config, weather) {
  const cfg = config || {};
  const effectsEnabled = cfg.effectsEnabled !== false;
  const automaticWeatherEnabled = cfg.automaticWeatherEnabled === true;
  const manualEffectId = typeof cfg.manualEffectId === "string" && cfg.manualEffectId ? cfg.manualEffectId : null;

  if (!effectsEnabled) return { key: null, source: "none" };
  if (manualEffectId) return { key: manualEffectId, source: "manual" };
  if (automaticWeatherEnabled && weather && weather.effect) {
    return { key: weather.effect, variant: weather.variant, isNight: weather.isNight, source: "weather" };
  }
  return { key: null, source: "none" };
}

// Human-readable label for a normalized effect key, for the Live Status card.
export const EFFECT_LABELS = {
  sunny: { icon: "☀️", name: "Sunny / Clear" },
  cloudy: { icon: "☁️", name: "Cloudy" },
  rain: { icon: "🌧️", name: "Rain / Thunderstorm" },
  snow: { icon: "❄️", name: "Snow" },
  fog: { icon: "🌫️", name: "Mist / Fog / Haze" },
};

// Firebase ES Module imports (Direct CDN se)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// Teri Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyBLzGd0DlItKShk0eJoQR4CjRx1sP3-o-w",
  authDomain: "billing-system-f8531.firebaseapp.com",
  projectId: "billing-system-f8531",
  storageBucket: "billing-system-f8531.firebasestorage.app",
  messagingSenderId: "921228841270",
  appId: "1:921228841270:web:9013d59b3ef96dda40e397",
  measurementId: "G-JMPEJCCBHZ"
};

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Firestore Database (Isko hum baaki files me use karenge)
const db = getFirestore(app);

console.log("Firebase & Firestore Initialized Successfully! 🔥");

// Variables ko export kar rahe hain taaki doosri files me use kar sakein
export { app, db };

// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDtqhO3Q3OsaUr6vGVWZ_Orr3jqW7TGPGI",
  authDomain: "cobro-isj.firebaseapp.com",
  projectId: "cobro-isj",
  storageBucket: "cobro-isj.firebasestorage.app",
  messagingSenderId: "291983311719",
  appId: "1:291983311719:web:0a73e7a490f4902fc925c2",
  measurementId: "G-8YS50BLQM8"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
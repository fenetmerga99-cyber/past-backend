// services/firebaseAdmin.js
// Lets this backend write directly to your Firestore, so a solved exam
// gets published even if the teacher's browser tab is long closed.
//
// Needs a Firebase *service account* key (very different from the public
// Firebase client apiKey already in your HTML files — this one is secret
// and grants full read/write access, never put it in a browser file).
//
// Set it via one env var, FIREBASE_SERVICE_ACCOUNT_BASE64, containing the
// entire downloaded JSON key, base64-encoded (see README for how to get
// and encode it).

const admin = require('firebase-admin');

function initFirebaseAdmin() {
  if (admin.apps.length) return admin; // already initialized

  const encoded = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!encoded) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_BASE64 is not set. See README.md for how to generate and encode your service account key.'
    );
  }

  let serviceAccount;
  try {
    const json = Buffer.from(encoded, 'base64').toString('utf8');
    serviceAccount = JSON.parse(json);
  } catch (e) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is not valid base64-encoded JSON.');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return admin;
}

let cachedDb = null;

function getDb() {
  if (cachedDb) return cachedDb;

  if (!admin.apps.length) {
    initFirebaseAdmin();
  }
  cachedDb = admin.firestore();
  return cachedDb;
}

module.exports = { admin, getDb };

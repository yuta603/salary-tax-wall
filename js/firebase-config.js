(() => {
  "use strict";

  if (typeof firebase === "undefined") return;

  const firebaseConfig = {
    apiKey: "AIzaSyBRTMjR2cb02vNZxy7Cjfsq9I0HCdv3yPw",
    authDomain: "salary-tax-wall-ffb9b.firebaseapp.com",
    projectId: "salary-tax-wall-ffb9b",
    storageBucket: "salary-tax-wall-ffb9b.firebasestorage.app",
    messagingSenderId: "681649510033",
    appId: "1:681649510033:web:08f389702a5d44ba585130",
    measurementId: "G-JS6NWX3CWK"
  };

  firebase.initializeApp(firebaseConfig);
  window.fbAuth = firebase.auth();
  window.fbDb = firebase.firestore();
  window.fbDb.enablePersistence({ synchronizeTabs: true }).catch(() => {
    // 複数タブや対応していないブラウザではオフラインキャッシュのみ無効化される（同期自体には影響しない）
  });
})();

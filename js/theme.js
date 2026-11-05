'use strict';

// =====================================================
// テーマ（ダーク / ライト）の切り替え
// ※ 画面のちらつきを防ぐため <head> 内で読み込み、描画前にテーマを適用する
// =====================================================

(() => {
  // 保存に使うキー
  const STORAGE_KEY = 'audioClipper.theme';
  // OSのダークモード設定
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

  // 保存済みのテーマを取得する（未保存・保存領域が使えない場合は null）
  function loadSavedTheme() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved === 'light' || saved === 'dark' ? saved : null;
    } catch (_) {
      return null;
    }
  }

  // テーマを画面に適用し、変更を他の処理（波形の再描画など）へ通知する
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    updateToggleButton();
    document.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
  }

  // 現在のテーマを取得する
  function currentTheme() {
    return document.documentElement.dataset.theme;
  }

  // 切り替えボタンの表示を現在のテーマに合わせる（押すと切り替わる先を表示）
  function updateToggleButton() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    const isDark = currentTheme() === 'dark';
    btn.textContent = isDark ? '☀ ライト' : '🌙 ダーク';
    btn.title = isDark ? 'ライトテーマに切り替え' : 'ダークテーマに切り替え';
  }

  // 初期テーマ：保存済みの設定 → なければOSの設定に合わせる
  document.documentElement.dataset.theme = loadSavedTheme() || (darkQuery.matches ? 'dark' : 'light');

  // ユーザーが明示的に選んでいない間は、OSの設定変更に追従する
  darkQuery.addEventListener('change', (e) => {
    if (!loadSavedTheme()) applyTheme(e.matches ? 'dark' : 'light');
  });

  // ページ読み込み後に切り替えボタンを設定する
  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('themeToggle');
    updateToggleButton();
    btn.addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      // 選んだテーマを次回起動時のために保存（保存できない環境では無視）
      try { localStorage.setItem(STORAGE_KEY, next); } catch (_) { /* 無視 */ }
      applyTheme(next);
      // スペースキーでボタンが再度押されないようフォーカスを外す
      btn.blur();
    });
  });
})();

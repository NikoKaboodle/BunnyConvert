// BunnyConvert nav
// Loaded on every page. Handles:
// - Converters dropdown (click + hover)
// - Mobile menu toggle (hamburger)
// - Outside click / Esc to close

(function() {
  'use strict';

  function init() {
    // ----- Mobile menu toggle -----
    const navToggle = document.querySelector('.nav-toggle');
    const nav = document.querySelector('.nav');
    if (navToggle && nav) {
      navToggle.addEventListener('click', function() {
        const isOpen = nav.classList.toggle('open');
        navToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
      // Close mobile menu when clicking a link inside
      nav.addEventListener('click', function(e) {
        if (e.target.tagName === 'A' && nav.classList.contains('open')) {
          // Small delay so the link navigation is visible briefly
          setTimeout(function() {
            nav.classList.remove('open');
            navToggle.setAttribute('aria-expanded', 'false');
          }, 100);
        }
      });
    }

    // ----- Converters dropdown -----
    const dropdown = document.querySelector('.nav-dropdown');
    if (!dropdown) return;
    const trigger = dropdown.querySelector('.nav-trigger');
    if (!trigger) return;

    function open() { dropdown.classList.add('open'); trigger.setAttribute('aria-expanded', 'true'); }
    function close() { dropdown.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); }
    function toggle() { dropdown.classList.contains('open') ? close() : open(); }

    trigger.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); toggle(); });

    // Hover support on devices with a real mouse
    let hoverTimer;
    dropdown.addEventListener('mouseenter', function() { clearTimeout(hoverTimer); open(); });
    dropdown.addEventListener('mouseleave', function() { hoverTimer = setTimeout(close, 120); });

    // Close on outside click
    document.addEventListener('click', function(e) {
      if (!dropdown.contains(e.target)) close();
    });

    // Close on Esc
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        if (dropdown.classList.contains('open')) { close(); trigger.focus(); }
        if (nav && nav.classList.contains('open')) { nav.classList.remove('open'); if (navToggle) navToggle.setAttribute('aria-expanded', 'false'); }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

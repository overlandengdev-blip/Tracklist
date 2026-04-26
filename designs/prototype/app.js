/* ============================================
   TRACKLIST — Prototype Router & Interactions
   ============================================ */

// ---------- Page registry ----------
const pages = {
  home: document.getElementById('pageHome'),
  onboarding: document.getElementById('pageOnboarding'),
  login: document.getElementById('pageLogin'),
  signup: document.getElementById('pageSignup'),
  app: document.getElementById('pageApp'),
};

let currentPage = 'home';

function goToPage(pageName) {
  if (pageName === currentPage || !pages[pageName]) return;

  const prev = pages[currentPage];
  const next = pages[pageName];

  // Toggle in-app class on body so background dims when inside the app shell
  if (pageName === 'app') {
    document.body.classList.add('in-app');
  } else {
    document.body.classList.remove('in-app');
  }

  prev.classList.add('exiting');
  prev.classList.remove('active');

  setTimeout(() => {
    prev.classList.remove('exiting');

    // Replay data-animate elements on the entering page
    next.querySelectorAll('[data-animate]').forEach((el) => {
      el.style.animation = 'none';
      void el.offsetHeight; // force reflow
      el.style.animation = '';
    });

    next.classList.add('active');
    currentPage = pageName;

    // Reset onboarding to slide 0 whenever we enter it
    if (pageName === 'onboarding') {
      setOnboardingSlide(0);
    }

    // Default app screen = identify
    if (pageName === 'app') {
      goToScreen('identify', { instant: true });
    }
  }, 280);
}

// ---------- Onboarding ----------
let onboardingIndex = 0;
const ONBOARDING_TOTAL = 3;

function setOnboardingSlide(i) {
  onboardingIndex = i;
  const slides = document.querySelectorAll('#onboardingSlides .slide');
  const dots = document.querySelectorAll('#onboardingDots .dot');
  slides.forEach((s, idx) => s.classList.toggle('active', idx === i));
  dots.forEach((d, idx) => d.classList.toggle('active', idx === i));

  const nextBtn = document.getElementById('onboardingNext');
  if (nextBtn) {
    nextBtn.textContent = i === ONBOARDING_TOTAL - 1 ? 'Get started' : 'Next';
  }
}

function onboardingNext() {
  if (onboardingIndex < ONBOARDING_TOTAL - 1) {
    setOnboardingSlide(onboardingIndex + 1);
  } else {
    goToPage('signup');
  }
}

// ---------- In-app screen routing ----------
let currentScreen = 'identify';

function goToScreen(screenName, opts = {}) {
  const screens = document.querySelectorAll('.app-screen');
  const tabs = document.querySelectorAll('.tabbar .tab');
  const target = document.getElementById('screen' + capitalize(screenName));
  if (!target) return;

  screens.forEach((s) => s.classList.remove('active'));
  target.classList.add('active');

  tabs.forEach((t) => {
    t.classList.toggle('active', t.dataset.screen === screenName);
  });

  // Show/hide tab bar on screens where it doesn't belong (e.g., notifications, clipDetail, result)
  const hideTabsOn = ['result', 'clipDetail', 'notifications'];
  const tabbar = document.querySelector('.tabbar');
  if (tabbar) tabbar.style.display = hideTabsOn.includes(screenName) ? 'none' : '';

  // Animate entering screen (unless instant)
  if (!opts.instant) {
    target.style.animation = 'none';
    void target.offsetHeight;
    target.style.animation = '';
  }

  currentScreen = screenName;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- Record simulation ----------
let recording = false;
function simulateRecord() {
  if (recording) return;
  recording = true;

  const btn = document.getElementById('recordBtn');
  const status = document.getElementById('recordStatus');
  btn.classList.add('recording');
  status.textContent = 'Listening…';

  const messages = ['Listening…', 'Analyzing audio…', 'Matching fingerprint…'];
  let step = 0;
  const interval = setInterval(() => {
    step++;
    if (step < messages.length) status.textContent = messages[step];
  }, 700);

  setTimeout(() => {
    clearInterval(interval);
    btn.classList.remove('recording');
    status.textContent = 'Hold your phone up to the speaker';
    recording = false;
    goToScreen('result');
  }, 2400);
}

function simulateUpload() {
  // Placeholder — would open file picker on real device
  goToScreen('result');
}

// ---------- Propose bottom sheet ----------
function openProposeSheet() {
  document.getElementById('proposeBackdrop').classList.add('active');
  document.getElementById('proposeSheet').classList.add('active');
}

function closeProposeSheet() {
  document.getElementById('proposeBackdrop').classList.remove('active');
  document.getElementById('proposeSheet').classList.remove('active');
}

// Segmented confidence control
document.querySelectorAll('.segmented').forEach((group) => {
  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg');
    if (!btn) return;
    group.querySelectorAll('.seg').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

// ---------- Feed population ----------
const sampleFeed = [
  {
    id: 'c1',
    status: 'community',
    artVariant: 'purple',
    glyph: '♫',
    title: 'Untitled',
    artist: 'Help identify it',
    context: 'Mike · Fabric · 15 min ago',
    votes: 12,
  },
  {
    id: 'c2',
    status: 'matched',
    artVariant: 'pink',
    glyph: '◐',
    title: 'Strings of Life',
    artist: 'Derrick May',
    context: 'Sarah · Printworks · 42 min ago',
    votes: 38,
  },
  {
    id: 'c3',
    status: 'community',
    artVariant: 'green',
    glyph: '◯',
    title: 'Midnight Drive',
    artist: 'Floating Points (proposed)',
    context: 'Alex · Berghain · 2 h ago',
    votes: 7,
  },
  {
    id: 'c4',
    status: 'unmatched',
    artVariant: 'orange',
    glyph: '?',
    title: 'Untitled',
    artist: 'Nobody knows yet',
    context: 'Jess · Output · 4 h ago',
    votes: 0,
  },
  {
    id: 'c5',
    status: 'matched',
    artVariant: 'purple',
    glyph: '♪',
    title: 'Opal',
    artist: 'Four Tet',
    context: 'Dan · Warehouse · Yesterday',
    votes: 22,
  },
];

function renderFeed() {
  const list = document.getElementById('feedList');
  if (!list) return;
  list.innerHTML = sampleFeed
    .map(
      (c) => `
    <article class="feed-card" data-id="${c.id}" onclick="openClipDetail('${c.id}')">
      <div class="feed-art ${c.artVariant}">${c.glyph}</div>
      <div class="feed-body">
        <div class="feed-title">${escapeHtml(c.title)}</div>
        <div class="feed-artist">${escapeHtml(c.artist)}</div>
        <div class="feed-meta">
          <span>${escapeHtml(c.context)}</span>
          <span class="status-pill ${c.status}">${c.status}</span>
        </div>
      </div>
    </article>
  `
    )
    .join('');
}

function openClipDetail(id) {
  const clip = sampleFeed.find((c) => c.id === id);
  if (clip) {
    const t = document.getElementById('clipDetailTitle');
    const a = document.getElementById('clipDetailArtist');
    const ctx = document.getElementById('clipDetailContext');
    if (t) t.textContent = clip.title;
    if (a) a.textContent = clip.artist;
    if (ctx) ctx.textContent = clip.context;
  }
  goToScreen('clipDetail');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Vote buttons (visual only)
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.vote-btn');
  if (!btn) return;
  btn.classList.toggle('voted');
});

// ---------- Boilerplate from original ----------
// Per-element delays
document.querySelectorAll('[data-delay]').forEach((el) => {
  const delay = el.getAttribute('data-delay');
  el.style.setProperty('--delay', `${delay}ms`);
});

// Video resilience
['bgVideo', 'bgVideo2'].forEach((id) => {
  const v = document.getElementById(id);
  if (!v) return;
  v.addEventListener('error', () => {
    v.style.display = 'none';
  });
  v.play?.().catch(() => {});
});

// Prevent pull-to-refresh on mobile
document.addEventListener('touchmove', (e) => {
  if (e.scale !== 1) e.preventDefault();
}, { passive: false });

// ---------- Init ----------
renderFeed();
setOnboardingSlide(0);

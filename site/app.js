// Reads the invite from the URL fragment, which browsers never send to a server, and
// fills in the page. Everything from the fragment goes in as text, never as markup.
const CODE = /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{3}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{3}$/;
const LANGUAGE_KEY = "sinkro-language";

const COPY = {
  en: {
    language: "Language",
    github: "Open source · GitHub",
    kickerLanding: "Watch party for the whole web",
    titleLanding: "Same movie. Same second. Different couches.",
    ledeLanding:
      "Sinkro is a free, open-source watch party extension for Chrome, Edge and Firefox that keeps any video on any website in sync with your friends.",
    kickerInvite: "You're invited",
    titleInvite: "You're invited to movie night",
    ledeInvite:
      "Add Sinkro to your browser and watch the same video with your friends, in the same second. Free, no account needed.",
    ledeInstalled: "Sinkro is ready. Join the room and you'll watch together, in the same second.",
    install: "Get Sinkro, it's free",
    installNote: "Once it's installed, you can join from here. No button? Reload this page.",
    joinRoom: "Join the room",
    joining: "Joining…",
    joinFailed: "That didn't work. Reload the page and try again.",
    joined: "You're in the room",
    joinedHelp: "Open the video in this tab and you'll be in sync.",
    roomLabel: "Room",
    destinationLabel: "This takes you to",
    openVideo: "Open the video",
    noDestination:
      "This invite doesn't say which video. Ask for the link again, or open it yourself.",
    stepsTitle: "How it works",
    step1Title: "Install the extension",
    step1Body: "A few seconds, no account. Then this page takes you straight to the room.",
    step2Title: "Open the video with your own account",
    step2Body: "On sites that need a subscription, everyone watches with their own account.",
    step3Title: "Watch together",
    step3Body: "Play, pause, seek: everyone's video changes at the same moment.",
    privacyLine:
      "Only playback state and the video's address and title are shared, never the video. No account, no tracking.",
    privacy: "Privacy",
    source: "Source code",
  },
  tr: {
    language: "Dil",
    github: "Açık kaynak · GitHub",
    kickerLanding: "Tüm web için birlikte izleme",
    titleLanding: "Aynı film. Aynı saniye. Farklı koltuklar.",
    ledeLanding:
      "Sinkro, herhangi bir sitedeki herhangi bir videoyu arkadaşlarınla senkron tutan, Chrome, Edge ve Firefox için ücretsiz ve açık kaynak bir birlikte izleme eklentisidir.",
    kickerInvite: "Bir davetin var",
    titleInvite: "Film gecesine davetlisin",
    ledeInvite:
      "Sinkro'yu tarayıcına ekle; aynı videoyu arkadaşlarınla aynı saniyede izle. Ücretsiz, hesap gerektirmez.",
    ledeInstalled: "Sinkro hazır. Odaya katıl, aynı saniyede birlikte izleyin.",
    install: "Sinkro'yu edin, ücretsiz",
    installNote: "Kurulunca buradan katılabilirsin. Düğme çıkmadıysa bu sayfayı yenile.",
    joinRoom: "Odaya katıl",
    joining: "Katılınıyor…",
    joinFailed: "Olmadı. Sayfayı yenileyip yeniden dene.",
    joined: "Odadasın",
    joinedHelp: "Videoyu bu sekmede aç, senkron olursun.",
    roomLabel: "Oda",
    destinationLabel: "Şuraya götürür",
    openVideo: "Videoyu aç",
    noDestination:
      "Bu davet hangi video olduğunu söylemiyor. Linki yeniden iste ya da videoyu kendin aç.",
    stepsTitle: "Nasıl çalışır",
    step1Title: "Eklentiyi kur",
    step1Body: "Birkaç saniye, hesap yok. Sonra bu sayfa seni doğrudan odaya götürür.",
    step2Title: "Videoyu kendi hesabınla aç",
    step2Body: "Abonelik gereken sitelerde herkes kendi hesabıyla izler.",
    step3Title: "Birlikte izleyin",
    step3Body: "Oynat, durdur, sar: herkesin videosu aynı anda değişir.",
    privacyLine:
      "Videonun kendisi değil, yalnızca oynatma durumu, video adresi ve başlığı paylaşılır. Hesap yok, takip yok.",
    privacy: "Gizlilik",
    source: "Kaynak kodu",
  },
};

function readInvite() {
  const params = new URLSearchParams(location.hash.slice(1));
  const code = (params.get("room") ?? "").toUpperCase();
  if (!CODE.test(code)) return null;

  let destination = null;
  try {
    const url = new URL(params.get("url") ?? "");
    if (url.protocol === "https:" || url.protocol === "http:") destination = url;
  } catch {
    // No address, or not one a browser can open.
  }
  return { code, destination };
}

function savedLanguage() {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (saved && COPY[saved]) return saved;
  } catch {
    // Storage can be blocked. The browser's language will do.
  }
  return navigator.language.toLowerCase().startsWith("tr") ? "tr" : "en";
}

function saveLanguage(language) {
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // It just won't be remembered.
  }
}

const element = (id) => document.getElementById(id);

// Each browser's own store. Edge installs from the Chrome Web Store, so it shares that link.
const STORES = {
  chrome:
    "https://chromewebstore.google.com/detail/sinkro-%E2%80%94-watch-party-sync/gndjbfbcaaffalmlcjlhofbboopbcgdc",
  firefox: "https://addons.mozilla.org/firefox/addon/sinkro/",
};
const storeLink = () => (/\bFirefox\//.test(navigator.userAgent) ? STORES.firefox : STORES.chrome);
/** The extension's content script sets this, and handles the click on the join button. */
const isInstalled = () => document.documentElement.dataset.sinkro !== undefined;
const hasJoined = () => document.documentElement.dataset.sinkro === "joined";

let language = savedLanguage();
let joinTimeout = null;

function render() {
  const copy = COPY[language];
  const invite = readInvite();

  document.documentElement.lang = language;
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = copy[node.dataset.i18n];
  }
  for (const node of document.querySelectorAll("[data-i18n-aria-label]")) {
    node.setAttribute("aria-label", copy[node.dataset.i18nAriaLabel]);
  }
  for (const button of document.querySelectorAll("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === language));
  }

  // In a new tab, so this page is still here to join from once it's installed.
  element("install").href = storeLink();
  element("room-card").hidden = !invite;
  element("join-room").hidden = !invite || !isInstalled();
  element("install").hidden = Boolean(invite) && isInstalled();
  element("install-note").hidden = !invite || isInstalled();
  if (!invite) return;

  element("kicker").textContent = copy.kickerInvite;
  element("title").textContent = copy.titleInvite;
  element("lede").textContent = isInstalled() ? copy.ledeInstalled : copy.ledeInvite;
  if (hasJoined()) {
    clearTimeout(joinTimeout);
    element("join-room").disabled = true;
    element("join-room").textContent = copy.joined;
    element("lede").textContent = copy.joinedHelp;
  }
  element("room-code").textContent = invite.code;

  // The address is on show before anyone joins, because joining goes there.
  element("destination-row").hidden = !invite.destination;
  element("no-destination").hidden = Boolean(invite.destination);
  if (invite.destination) {
    element("destination").textContent = invite.destination.hostname;
    element("destination-link").href = invite.destination.href;
  }
}

for (const button of document.querySelectorAll("[data-lang]")) {
  button.addEventListener("click", () => {
    language = button.dataset.lang;
    saveLanguage(language);
    render();
  });
}

element("join-room").addEventListener("click", () => {
  const button = element("join-room");
  button.disabled = true;
  button.textContent = COPY[language].joining;
  // Joining either leaves this page or marks it as joined, so silence means it failed.
  joinTimeout = setTimeout(() => {
    button.disabled = false;
    button.textContent = COPY[language].joinFailed;
  }, 5000);
});

// The content script runs after this page has loaded, so watch for it arriving.
new MutationObserver(render).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-sinkro"],
});
window.addEventListener("hashchange", render);
render();

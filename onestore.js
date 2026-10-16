// S32: Last Genesis on ONE store's AI game shelf (the "Web (ONE store)" export, web/onestore_shell.html).
// ONE store's H5 Game SDK (v1.1.0) runs the page's lifecycle and the full version's purchase; this
// file is the page's side of it. It is a plain script so `window.lgStore` exists before the game
// starts, whether or not the SDK's module ever loads; the shell's module script imports the SDK
// and calls lgOne.attach(createSDK()).
//
// Lifecycle (SDK guide 03): listeners first, then initializeAsync(); the engine's download
// progress goes to setLoadingProgress(); startGameAsync() once the engine has started, which takes
// ONE store's own loading screen away. pause/resume reach the game through lgStore.listen; the
// back key asks the game synchronously (it must answer within 200 ms; the web build has no
// threads, so the game's callback runs inside this call).
//
// The game's side (WzStore, scripts/view/store.gd) calls:
//   lgStore.listen(cb)   events as JSON: {"event":"pause"|"resume"|"back"|"ready", ...}
//   lgStore.product(cb)  {"ok":true,"price":"3,300원"} or {"ok":false,"reason":...}
//   lgStore.buy(cb)      {"ok":true} (bought, or already owned: "restored":true) or {"ok":false,"reason":...}
//   lgStore.consumed     set by the game during a "back" event: true when the game used the key
// Every callback gets one JSON string. Reasons are the SDK's (guide 06), plus "sdk_unavailable"
// when the SDK never loaded (no network, an ordinary browser that blocked the CDN).
(function (root) {
	"use strict";
	var PRODUCT_ID = "lastgenesis_full";
	var SDK_WAIT_MS = 15000;
	var INIT_TRIES = 3;

	function makeBridge(timers) {
		var sdk = null;
		var state = { initialized: false, unsupported: false, loaded: false, started: false, progress: 0, failed: "" };
		var listener = null;
		var queue = [];
		var waiting = [];

		function emit(ev) {
			if (listener) listener(JSON.stringify(ev));
			else queue.push(ev);
		}
		function reply(cb, value) {
			try { cb(JSON.stringify(value)); } catch (e) { console.error("lgStore reply", e); }
		}
		// The SDK once initialised; rejects with a reason when it never will be.
		function ready() {
			return new Promise(function (resolve, reject) {
				if (state.initialized) return resolve(sdk);
				if (state.unsupported) return reject(state.failed || "platform_not_supported");
				waiting.push({ resolve: resolve, reject: reject });
			});
		}
		function settle() {
			var all = waiting;
			waiting = [];
			all.forEach(function (w) {
				if (state.initialized) w.resolve(sdk);
				else w.reject(state.failed || "platform_not_supported");
			});
		}
		function fail(reason) {
			if (state.initialized) return;
			state.unsupported = true;
			state.failed = reason;
			settle();
		}
		function maybeStart() {
			if (!state.initialized || !state.loaded || state.started) return;
			state.started = true;
			sdk.startGameAsync().then(function () {
				emit({ event: "ready" });
			}, function (e) {
				console.error("startGameAsync", e && e.reason, e && e.message);
			});
		}
		function initialise(left) {
			sdk.initializeAsync().then(function (info) {
				if (info && info.err) {
					// An ordinary browser: the game runs as the trial, nothing to buy.
					fail("platform_not_supported");
					return;
				}
				state.initialized = true;
				sdk.setLoadingProgress(state.progress);
				settle();
				if (info && typeof info.ringerSilent === "boolean") emit({ event: "ringer", silent: info.ringerSilent });
				maybeStart();
			}, function (e) {
				console.warn("initializeAsync", e && e.reason, e && e.message);
				if (left > 1) timers.setTimeout(function () { initialise(left - 1); }, 1000);
				else fail((e && e.reason) || "internal_error");
			});
		}
		function formatPrice(p) {
			var amount = Number(p.priceAmountMicros) / 1000000;
			if (p.priceCurrencyCode === "KRW" && isFinite(amount)) return Math.round(amount).toLocaleString("ko-KR") + "원";
			return String(p.price) + (p.priceCurrencyCode ? " " + p.priceCurrencyCode : "");
		}

		var store = {
			consumed: false,
			listen: function (cb) {
				listener = cb;
				var held = queue;
				queue = [];
				held.forEach(emit);
			},
			product: function (cb) {
				ready().then(function (s) {
					if (!s.iap.isSupported("getProductDetails")) return reply(cb, { ok: false, reason: "platform_not_supported" });
					return s.iap.getProductDetailsAsync([PRODUCT_ID]).then(function (products) {
						var p = (products || []).filter(function (x) { return x && x.productId === PRODUCT_ID; })[0];
						if (!p) return reply(cb, { ok: false, reason: "not_on_sale" });
						reply(cb, { ok: true, price: formatPrice(p) });
					}, function (e) {
						reply(cb, { ok: false, reason: (e && e.reason) || "internal_error" });
					});
				}, function (reason) {
					reply(cb, { ok: false, reason: reason });
				});
			},
			// A managed product is never consumed here, so buying again after a purchase (another
			// phone, cleared storage) answers already_owned without a charge: that is the restore.
			buy: function (cb) {
				ready().then(function (s) {
					if (!s.iap.isSupported("purchase")) return reply(cb, { ok: false, reason: "platform_not_supported" });
					return s.iap.purchase({ productId: PRODUCT_ID }).then(function (r) {
						if (r && r.productId && r.productId !== PRODUCT_ID) return reply(cb, { ok: false, reason: "wrong_product" });
						reply(cb, { ok: true });
					}, function (e) {
						var reason = (e && e.reason) || "internal_error";
						if (reason === "already_owned") reply(cb, { ok: true, restored: true });
						else reply(cb, { ok: false, reason: reason });
					});
				}, function (reason) {
					reply(cb, { ok: false, reason: reason });
				});
			},
		};

		var one = {
			store: store,
			state: state,
			attach: function (created) {
				if (sdk) return;
				sdk = created;
				sdk.on("pause", function (ev) { emit({ event: "pause", reason: (ev && ev.reason) || "" }); });
				sdk.on("resume", function (ev) {
					var e = { event: "resume" };
					if (ev && typeof ev.ringerSilent === "boolean") e.silent = ev.ringerSilent;
					emit(e);
				});
				// No "exit" listener: the voyage is saved at every leg's start and end and on every
				// purchase, and a leg in flight starts again from its start anyway (WzGame).
				sdk.onBackPressed(function () {
					if (!listener) return false;
					store.consumed = false;
					listener(JSON.stringify({ event: "back" }));
					return store.consumed === true;
				});
				initialise(INIT_TRIES);
			},
			// The shell: the engine's download (0..1) and its start.
			progress: function (fraction) {
				state.progress = Math.max(0, Math.min(100, Math.round(fraction * 100)));
				if (state.initialized) sdk.setLoadingProgress(state.progress);
			},
			loaded: function () {
				state.loaded = true;
				state.progress = 100;
				if (state.initialized) sdk.setLoadingProgress(100);
				maybeStart();
			},
		};
		timers.setTimeout(function () { if (!sdk) fail("sdk_unavailable"); }, SDK_WAIT_MS);
		return one;
	}

	root.lgMakeBridge = makeBridge;
	if (root.window === root && !root.lgOne) {
		root.lgOne = makeBridge(root);
		root.lgStore = root.lgOne.store;
	}
}(typeof window !== "undefined" ? window : globalThis));

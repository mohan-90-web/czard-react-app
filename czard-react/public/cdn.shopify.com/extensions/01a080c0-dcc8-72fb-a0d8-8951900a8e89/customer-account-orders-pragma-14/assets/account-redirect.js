(function () {
  var CUSTOMER_OS_PATH = "/apps/customer-os";
  var CUSTOMER_OS_ORDERS_PATH = CUSTOMER_OS_PATH + "/orders";
  var APP_STATUS_PATH = CUSTOMER_OS_PATH + "/api/app-status";
  var KWIKPASS_SELECTORS = [
    "#kwikpass-drawer-desktop",
    "#kwikpass-drawer-mobile",
    "[id^='kwikpass-drawer']",
    "[class*='kwikpass']"
  ];
  var kwikpassLoginWrapped = false;
  var ACCOUNT_ENTRY_SEGMENTS = {
    account: true,
    login: true,
    register: true,
    activate: true,
    challenge: true
  };
  var EXCLUDED_ACCOUNT_SEGMENTS = {
    addresses: true,
    logout: true,
    orders: true
  };
  var CUSTOMER_AUTH_ENTRY_SEGMENTS = {
    redirect: true,
    login: true,
    register: true
  };

  function normalizePath(pathname) {
    if (!pathname) {
      return "/";
    }
    return pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  }

  function stripLocalePrefix(segments) {
    if (!segments.length) {
      return segments;
    }

    var first = segments[0].toLowerCase();
    var isLocale = /^[a-z]{2}(-[a-z]{2})?$/i.test(first);
    return isLocale ? segments.slice(1) : segments;
  }

  function isCustomShopifyAccountEntryUrl(parsed) {
    var hostname = parsed.hostname.toLowerCase();
    var path = normalizePath(parsed.pathname);

    if (hostname.indexOf("account.") !== 0 || path !== "/") {
      return false;
    }

    // Shopify custom customer-account domains include these signed entry
    // parameters when a storefront account icon opens the account experience.
    return (
      parsed.searchParams.has("buyer_flags") ||
      parsed.searchParams.has("consent") ||
      parsed.searchParams.has("region_country")
    );
  }

  function isShopifyHostedAccountEntryUrl(parsed) {
    if (parsed.hostname !== "shopify.com") {
      return false;
    }

    var segments = parsed.pathname.split("/").filter(Boolean);

    if (
      segments.length >= 3 &&
      segments[0] === "authentication" &&
      segments[2] === "login"
    ) {
      return true;
    }

    if (segments.length < 2 || segments[1] !== "account") {
      return false;
    }

    if (segments.length === 2) {
      return true;
    }

    return EXCLUDED_ACCOUNT_SEGMENTS[segments[2]] !== true;
  }

  function isAccountEntryUrl(url) {
    try {
      var parsed = new URL(url, window.location.origin);
      if (parsed.origin !== window.location.origin) {
        return (
          isShopifyHostedAccountEntryUrl(parsed) ||
          isCustomShopifyAccountEntryUrl(parsed)
        );
      }

      var path = normalizePath(parsed.pathname);
      var segments = stripLocalePrefix(path.split("/").filter(Boolean));

      if (!segments.length) {
        return false;
      }

      if (segments[0] === "customer_authentication") {
        var subEntry = segments[1];
        if (!subEntry) {
          return true;
        }
        return CUSTOMER_AUTH_ENTRY_SEGMENTS[subEntry] === true;
      }

      if (segments[0] !== "account") {
        return false;
      }

      if (segments.length === 1) {
        return true;
      }

      var next = segments[1];
      if (EXCLUDED_ACCOUNT_SEGMENTS[next]) {
        return false;
      }

      return ACCOUNT_ENTRY_SEGMENTS[next] === true;
    } catch (_error) {
      return false;
    }
  }

  function customerOsUrl() {
    return window.location.origin + CUSTOMER_OS_PATH;
  }

  function customerOsOrdersUrl() {
    return window.location.origin + CUSTOMER_OS_ORDERS_PATH;
  }

  function defaultAccountUrl() {
    return window.location.origin + "/account";
  }

  function appStatusUrl() {
    return window.location.origin + APP_STATUS_PATH;
  }

  function fetchCustomerOsStatus() {
    if (!window.fetch) {
      return Promise.resolve({ enabled: false, fallbackUrl: defaultAccountUrl() });
    }

    return window.fetch(appStatusUrl(), {
      credentials: "same-origin",
      headers: {
        "Accept": "application/json"
      }
    })
      .then(function (response) {
        if (!response.ok) {
          return { enabled: false, fallbackUrl: defaultAccountUrl() };
        }
        return response.json();
      })
      .then(function (status) {
        return {
          enabled: status && status.enabled === true,
          fallbackUrl: status && status.fallback_url
            ? status.fallback_url
            : defaultAccountUrl()
        };
      })
      .catch(function () {
        return { enabled: false, fallbackUrl: defaultAccountUrl() };
      });
  }

  function rewriteAccountLinks(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var links = [];

    if (scope.matches && scope.matches("a[href]")) {
      links.push(scope);
    }

    scope.querySelectorAll("a[href]").forEach(function (link) {
      links.push(link);
    });

    links.forEach(function (link) {
      if (link.dataset.customerOsAccountLink === "true") {
        return;
      }

      if (!isAccountEntryUrl(link.href)) {
        return;
      }

      link.href = customerOsUrl();
      link.dataset.customerOsAccountLink = "true";
    });
  }

  function isInsideKwikpass(node) {
    if (!node || !node.closest) {
      return false;
    }

    return KWIKPASS_SELECTORS.some(function (selector) {
      return Boolean(node.closest(selector));
    });
  }

  function isKwikpassOrderHistoryLink(link) {
    if (!link || !isInsideKwikpass(link)) {
      return false;
    }

    var text = (link.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    var onclick = link.getAttribute("onclick") || "";

    return (
      text.indexOf("order") !== -1 ||
      (onclick.indexOf("handleShopifyLogin") !== -1 && onclick.indexOf("/account") !== -1)
    );
  }

  function redirectKwikpassOrderHistory(event) {
    event.preventDefault();
    event.stopImmediatePropagation();

    if (typeof window.handleShopifyLogin === "function") {
      try {
        window.handleShopifyLogin(event, CUSTOMER_OS_ORDERS_PATH);
        return;
      } catch (_error) {
        // Fall through to a direct redirect if Kwikpass changes its handler.
      }
    }

    window.location.assign(customerOsOrdersUrl());
  }

  function rewriteKwikpassAccountLinks(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var links = [];

    if (scope.matches && scope.matches("a")) {
      links.push(scope);
    }

    scope.querySelectorAll("a").forEach(function (link) {
      links.push(link);
    });

    links.forEach(function (link) {
      if (!isKwikpassOrderHistoryLink(link)) {
        return;
      }

      link.href = customerOsOrdersUrl();
      link.dataset.customerOsKwikpassAccountLink = "true";
    });
  }

  function wrapKwikpassLoginHandler() {
    if (kwikpassLoginWrapped || typeof window.handleShopifyLogin !== "function") {
      return;
    }

    var original = window.handleShopifyLogin;
    if (original && original.customerOsWrapped === true) {
      kwikpassLoginWrapped = true;
      return;
    }

    window.handleShopifyLogin = function (event, target) {
      if (typeof target === "string" && isAccountEntryUrl(target)) {
        return original.call(this, event, CUSTOMER_OS_ORDERS_PATH);
      }

      return original.apply(this, arguments);
    };
    window.handleShopifyLogin.customerOsWrapped = true;
    kwikpassLoginWrapped = true;
  }

  function handleClick(event) {
    var path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (node && node.tagName === "SHOPIFY-ACCOUNT") {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.location.assign(customerOsUrl());
        return;
      }
    }

    var link = event.target && event.target.closest
      ? event.target.closest("a[href]")
      : null;

    if (!link) {
      return;
    }

    if (isKwikpassOrderHistoryLink(link)) {
      redirectKwikpassOrderHistory(event);
      return;
    }

    var isRewritten = link.dataset.customerOsAccountLink === "true";
    if (!isRewritten && !isAccountEntryUrl(link.href)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.assign(customerOsUrl());
  }

  function redirectCurrentAccountPage() {
    if (!isAccountEntryUrl(window.location.href)) {
      return;
    }

    window.location.replace(customerOsUrl());
  }

  function observeLinks() {
    if (!window.MutationObserver) {
      return;
    }

    var observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            return;
          }
          rewriteAccountLinks(node);
          rewriteKwikpassAccountLinks(node);
          wrapKwikpassLoginHandler();
        });
      });
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function restoreAccountLinks(root, fallbackUrl) {
    var scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll("a[data-customer-os-account-link='true']").forEach(
      function (link) {
        link.href = fallbackUrl || defaultAccountUrl();
        delete link.dataset.customerOsAccountLink;
      }
    );
  }

  function init() {
    fetchCustomerOsStatus().then(function (status) {
      if (!status.enabled) {
        restoreAccountLinks(document, status.fallbackUrl);
        return;
      }

      redirectCurrentAccountPage();
      rewriteAccountLinks(document);
      rewriteKwikpassAccountLinks(document);
      wrapKwikpassLoginHandler();
      observeLinks();
      document.addEventListener("click", handleClick, true);
      window.setTimeout(wrapKwikpassLoginHandler, 500);
      window.setTimeout(function () {
        rewriteKwikpassAccountLinks(document);
        wrapKwikpassLoginHandler();
      }, 1500);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

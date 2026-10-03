
    (function() {
      var preconnectOrigins = ["https://cdn.shopify.com"];
      var scripts = ["/cdn/shopifycloud/checkout-web/assets/c1/polyfills-legacy.CjqKEFia.js","cdn/shopifycloud/checkout-web/assets/c1/app-legacy.B8dvX_pu.js","cdn/shopifycloud/checkout-web/assets/c1/esnext-vendor-legacy.274mKwGx.js","cdn/shopifycloud/checkout-web/assets/c1/context-browser-legacy.f8BLUcg7.js","cdn/shopifycloud/checkout-web/assets/c1/checkout-policy-legacy.B06Wy7ss.js","cdn/shopifycloud/checkout-web/assets/c1/graphql-PaymentSessionMutation-legacy.CG0FCfCo.js","cdn/shopifycloud/checkout-web/assets/c1/helpers-installmentsNotSupportedForAddress-legacy.BInhNSUz.js","cdn/shopifycloud/checkout-web/assets/c1/mobile-checkout-sdk-MobileCheckoutSdkClient-legacy.Ih-rPGtL.js","cdn/shopifycloud/checkout-web/assets/c1/proposal-delegated-payment-instrument-legacy.vwXPzQla.js","cdn/shopifycloud/checkout-web/assets/c1/consent-manager-shared-legacy.CcUTd43f.js","cdn/shopifycloud/checkout-web/assets/c1/receipt-mapper-load-recovery-legacy.BpWhF5wv.js","cdn/shopifycloud/checkout-web/assets/c1/receipt-eager-mappers-legacy.Cu7foCwW.js","cdn/shopifycloud/checkout-web/assets/c1/shared-report-graphql-error-legacy.CclmDTDy.js","cdn/shopifycloud/checkout-web/assets/c1/shop-pay-normalizeBuyerDetails-legacy.CiEicjRK.js","cdn/shopifycloud/checkout-web/assets/c1/utilities-shopCashMoney-legacy.DTM0x3sd.js","cdn/shopifycloud/checkout-web/assets/c1/PayButton-helpers-legacy.zzlSdwT1.js","cdn/shopifycloud/checkout-web/assets/c1/hydrate-legacy.B3eUgcOf.js","cdn/shopifycloud/checkout-web/assets/c1/utilities-browser-legacy.Bqd6V9jg.js","cdn/shopifycloud/checkout-web/assets/c1/locale-en-legacy.Bg2vkhTU.js","cdn/shopifycloud/checkout-web/assets/c1/OnePage-legacy.Ca-DdlaF.js","cdn/shopifycloud/checkout-web/assets/c1/components-DeliveryTransition-legacy.CaTQToF1.js","cdn/shopifycloud/checkout-web/assets/c1/useShopPayButtonClassName-legacy.Bwpxuo_B.js","cdn/shopifycloud/checkout-web/assets/c1/negotiated-findSelectedDeliveryMethod-legacy.D4_qOjJD.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-useShouldRevealCustomization-legacy.DL3iFkbN.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-useCanChangeCompanyLocation-legacy.MguiJ-q5.js","cdn/shopifycloud/checkout-web/assets/c1/ChangeCompanyLocationLink-legacy.BFQHwwiP.js","cdn/shopifycloud/checkout-web/assets/c1/BillingAddressForm-legacy.OLB_ynry.js","cdn/shopifycloud/checkout-web/assets/c1/PhoneField-legacy.CERPojQT.js","cdn/shopifycloud/checkout-web/assets/c1/shipping-methods-grouping-legacy.BmNUNxmh.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-useUnauthenticatedErrorModal-legacy.BU632m7q.js","cdn/shopifycloud/checkout-web/assets/c1/utilities-compact-legacy.D5b3aIGV.js","cdn/shopifycloud/checkout-web/assets/c1/Popover-legacy.BmDwnzn5.js","cdn/shopifycloud/checkout-web/assets/c1/Choice-legacy.CLjjciEX.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-useSuppressShopPayModalOnLoad-legacy.CLMX1pL0.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-useForceShopPayUrl-legacy.BCnoP4FY.js","cdn/shopifycloud/checkout-web/assets/c1/ImpressionEventCapture-legacy.YeSQIn6P.js","cdn/shopifycloud/checkout-web/assets/c1/utilities-previous-legacy.BT2KOMdR.js","cdn/shopifycloud/checkout-web/assets/c1/ShopPayLogo-legacy.C90c3X2T.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-useWalletsTimeout-legacy.Y_3oTpMK.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-usePostPurchase-legacy.4o0eS59h.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-useWalletsMonorailTrack-legacy.U_6usSFK.js","cdn/shopifycloud/checkout-web/assets/c1/IncentiveBadge-legacy.htqmErhJ.js","cdn/shopifycloud/checkout-web/assets/c1/Section-SectionStyleOverride-legacy.BvqG8Wcn.js","cdn/shopifycloud/checkout-web/assets/c1/AutocompleteField-hooks-legacy.srAsMKtW.js","cdn/shopifycloud/checkout-web/assets/c1/PendingShipping-legacy.Oy6IyLRo.js","cdn/shopifycloud/checkout-web/assets/c1/Switch-legacy.ColU0ebu.js","cdn/shopifycloud/checkout-web/assets/c1/useAddressMutationsWithNegotiation-legacy.Dx_bd1mp.js","cdn/shopifycloud/checkout-web/assets/c1/PaymentIcon-legacy.CdtL5I66.js","cdn/shopifycloud/checkout-web/assets/c1/PaymentLine-legacy.ToBJ4wND.js","cdn/shopifycloud/checkout-web/assets/c1/Theme-ThemeOverride-legacy.DKdwmWE-.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-useUpdateCheckoutAddress-legacy.BoOaGqVG.js","cdn/shopifycloud/checkout-web/assets/c1/payment-usePaymentExemptionReason-legacy.Dxzn4uBA.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-useShopPayProgressIntercepts-legacy.DleUhThy.js","cdn/shopifycloud/checkout-web/assets/c1/Section-legacy.BiZlFxQE.js","cdn/shopifycloud/checkout-web/assets/c1/PaymentErrorBanner-legacy.CMZXnYL4.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-useGeneralPaymentErrorMessage-legacy.ByBDo6P0.js","cdn/shopifycloud/checkout-web/assets/c1/StickyPayButton-StickyPayButton.module-legacy.D4vor8jN.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-payment-button-legacy.BlkB3zp_.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-usePreselectSpi-legacy.uK0ttOit.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-useAvailableShopPromotionDiscounts-legacy.pQZserNP.js","cdn/shopifycloud/checkout-web/assets/c1/Middot-legacy.CmLHrRIy.js","cdn/shopifycloud/checkout-web/assets/c1/EstimatedDeliveryContent-legacy.oeTkNPtN.js","cdn/shopifycloud/checkout-web/assets/c1/ShippingMethodRateLabel-legacy.DTe2JFU6.js","cdn/shopifycloud/checkout-web/assets/c1/shipping-methods-consolidated-included-legacy.BVt6EWm5.js","cdn/shopifycloud/checkout-web/assets/c1/ShippingLines-legacy.BnH_MD-D.js","cdn/shopifycloud/checkout-web/assets/c1/ShipmentBreakdown-legacy.DSSW0q-l.js","cdn/shopifycloud/checkout-web/assets/c1/MerchandiseModal-legacy.DYvGUNxd.js","cdn/shopifycloud/checkout-web/assets/c1/ShippingMethodSelector-legacy.B2aTvVjz.js","cdn/shopifycloud/checkout-web/assets/c1/TextArea-legacy.Di8-RIzc.js","cdn/shopifycloud/checkout-web/assets/c1/SubscriptionPriceBreakdown-legacy.CR1bn8tl.js","cdn/shopifycloud/checkout-web/assets/c1/StockProblems-StockProblemsLineItemList-legacy.PmvlWvJ9.js","cdn/shopifycloud/checkout-web/assets/c1/page-BelowTheFoldContent-legacy.DodcTW_G.js","cdn/shopifycloud/checkout-web/assets/c1/Captcha-legacy.BLJGGvAP.js","cdn/shopifycloud/checkout-web/assets/c1/ShopPayCaptcha-legacy.CQQkAgmX.js","cdn/shopifycloud/checkout-web/assets/c1/RememberMeSection-legacy.CHMaanD9.js","cdn/shopifycloud/checkout-web/assets/c1/components-PaymentMethodProgressionHost-legacy.FWpL031F.js","cdn/shopifycloud/checkout-web/assets/c1/hooks-useShowShopPayOptin-legacy.D_cP7EAK.js","cdn/shopifycloud/checkout-web/assets/c1/MobileOrderSummary-legacy.DmPRDl6M.js","cdn/shopifycloud/checkout-web/assets/c1/useShopPaySessionTokenStorage-legacy.HSjshjTA.js","cdn/shopifycloud/checkout-web/assets/c1/PayButtonSection-legacy.Ui_H_w2P.js","cdn/shopifycloud/checkout-web/assets/c1/PaymentButtons-legacy.39M5aGLy.js","cdn/shopifycloud/checkout-web/assets/c1/utils-useViolationsHandler-legacy.i_vS7Kux.js","cdn/shopifycloud/checkout-web/assets/c1/PaymentOptionSelector-legacy.DkX_qk6x.js","cdn/shopifycloud/checkout-web/assets/c1/BillingAddressSelector-legacy.D7gHsFom.js","/cdn/shopifycloud/checkout-web/assets/c1/hooks-useStableHostMethodsReferences-legacy.DtNgF_8-.js"];
      var styles = [];
      var fontPreconnectUrls = [];
      var fontPrefetchUrls = [];
      var imgPrefetchUrls = ["https://cdn.shopify.com/s/files/1/0759/3787/4074/files/Czard_logo_square_x320.png?v=1785774442"];

      function preconnect(url, callback) {
        var link = document.createElement('link');
        link.rel = 'dns-prefetch preconnect';
        link.href = url;
        link.crossOrigin = '';
        link.onload = link.onerror = callback;
        document.head.appendChild(link);
      }

      function preconnectAssets() {
        var resources = preconnectOrigins.concat(fontPreconnectUrls);
        var index = 0;
        (function next() {
          var res = resources[index++];
          if (res) preconnect(res, next);
        })();
      }

      function prefetch(url, as, callback) {
        var link = document.createElement('link');
        if (link.relList.supports('prefetch')) {
          link.rel = 'prefetch';
          link.fetchPriority = 'low';
          link.as = as;
          if (as === 'font') link.type = 'font/woff2';
          link.href = url;
          link.crossOrigin = '';
          link.onload = link.onerror = callback;
          document.head.appendChild(link);
        } else {
          var xhr = new XMLHttpRequest();
          xhr.open('GET', url, true);
          xhr.onloadend = callback;
          xhr.send();
        }
      }

      function prefetchAssets() {
        var resources = [].concat(
          scripts.map(function(url) { return [url, 'script']; }),
          styles.map(function(url) { return [url, 'style']; }),
          fontPrefetchUrls.map(function(url) { return [url, 'font']; }),
          imgPrefetchUrls.map(function(url) { return [url, 'image']; })
        );
        var index = 0;
        function run() {
          var res = resources[index++];
          if (res) prefetch(res[0], res[1], next);
        }
        var next = (self.requestIdleCallback || setTimeout).bind(self, run);
        next();
      }

      function onLoaded() {
        try {
          if (parseFloat(navigator.connection.effectiveType) > 2 && !navigator.connection.saveData) {
            preconnectAssets();
            prefetchAssets();
          }
        } catch (e) {}
      }

      if (document.readyState === 'complete') {
        onLoaded();
      } else {
        addEventListener('load', onLoaded);
      }
    })();
  
const LimePixel = (function(){
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let random = bytes => crypto.getRandomValues(new Uint8Array(bytes));
  /** Code taken directly from nanoid's source */
  let customRandom = (alphabet, defaultSize, getRandom) => {
    // First, a bitmask is necessary to generate the ID. The bitmask makes bytes
    // values closer to the alphabet size. The bitmask calculates the closest
    // `2^31 - 1` number, which exceeds the alphabet size.
    // For example, the bitmask for the alphabet size 30 is 31 (00011111).
    // `Math.clz32` is not used, because it is not available in browsers.
    let mask = (2 << (Math.log(alphabet.length - 1) / Math.LN2)) - 1
    // Though, the bitmask solution is not perfect since the bytes exceeding
    // the alphabet size are refused. Therefore, to reliably generate the ID,
    // the random bytes redundancy has to be satisfied.

    // Note: every hardware random generator call is performance expensive,
    // because the system call for entropy collection takes a lot of time.
    // So, to avoid additional system calls, extra bytes are requested in advance.

    // Next, a step determines how many random bytes to generate.
    // The number of random bytes gets decided upon the ID size, mask,
    // alphabet size, and magic number 1.6 (using 1.6 peaks at performance
    // according to benchmarks).

    // `-~f => Math.ceil(f)` if f is a float
    // `-~i => i + 1` if i is an integer
    let step = -~((1.6 * mask * defaultSize) / alphabet.length)

    return (size = defaultSize) => {
      let id = ''
      while (true) {
        let bytes = getRandom(step)
        // A compact alternative for `for (var i = 0; i < step; i++)`.
        let j = step
        while (j--) {
          // Adding `|| ''` refuses a random byte that exceeds the alphabet size.
          id += alphabet[bytes[j] & mask] || ''
          if (id.length === size) return id
        }
      }
    }
  }
  let customAlphabet = (alphabet, size = 21) => customRandom(alphabet, size, random);
  const nanoid = customAlphabet(alphabet, 18);

  const lcRefTkn = '6c7266745f77617669636c65';
  const limechatPixelKey = '__lc_p';
  const limechatSessionKey = '__lc_s';
  const utm_sourceKey = 'utm_source';
  const utm_mediumKey = 'utm_medium';
  const utm_campaignKey = 'utm_campaign';
  const utm_termKey = 'utm_term';
  const utm_contentKey = 'utm_content';
  const conversionExpiry = 2.592e+8; // 3 days in miliseconds

  function isRefProvidedByLC(refValue){
    return refValue.endsWith(lcRefTkn);
  }

  function isReferredByLC(){
    const urlQueryParams = new URLSearchParams(window.location.search);
    const queryParams = Object.fromEntries(urlQueryParams.entries());
    return [queryParams.ref && isRefProvidedByLC(queryParams.ref), queryParams.ref, queryParams.utm_source, queryParams.utm_medium, queryParams.utm_campaign, queryParams.utm_term, queryParams.utm_content];
  }

  function setLocalStorageWithExpiry(key, value, ttl) {
    const now = new Date();

    const item = {
      value: value,
      expiry: now.getTime() + ttl,
    }
    localStorage.setItem(key, JSON.stringify(item));
  }

  function getLocalStorageWithExpiry(key) {
    const itemStr = localStorage.getItem(key);
    if (!itemStr) {
      return null
    }
    const item = JSON.parse(itemStr);
    const now = new Date();
    if (now.getTime() > item.expiry) {
      localStorage.removeItem(key);
      return null;
    }
    return item.value;
  }

  function createLCTrackingProps(value, limechatSessionID, utm_source, utm_medium, utm_campaign, utm_term, utm_content){
    const lcTrackingProp = document.createElement('input');
    lcTrackingProp.setAttribute('type', 'hidden');
    lcTrackingProp.setAttribute('name', `properties[${limechatPixelKey}]`);
    lcTrackingProp.setAttribute('value', `${value}`);
    const limechatSessionIDProp = document.createElement('input');
    limechatSessionIDProp.setAttribute('type', 'hidden');
    limechatSessionIDProp.setAttribute('name', `properties[${limechatSessionKey}]`);
    limechatSessionIDProp.setAttribute('value', limechatSessionID);
    const utm_sourceProp = document.createElement('input');
    utm_sourceProp.setAttribute('type', 'hidden');
    utm_sourceProp.setAttribute('name', `properties[${utm_sourceKey}]`);
    utm_sourceProp.setAttribute('value', utm_source);
    const utm_mediumProp = document.createElement('input');
    utm_mediumProp.setAttribute('type', 'hidden');
    utm_mediumProp.setAttribute('name', `properties[${utm_mediumKey}]`);
    utm_mediumProp.setAttribute('value', utm_medium);
    const utm_campaignProp = document.createElement('input');
    utm_campaignProp.setAttribute('type', 'hidden');
    utm_campaignProp.setAttribute('name', `properties[${utm_campaignKey}]`);
    utm_campaignProp.setAttribute('value', utm_campaign);
    const utm_termProp = document.createElement('input');
    utm_termProp.setAttribute('type', 'hidden');
    utm_termProp.setAttribute('name', `properties[${utm_termKey}]`);
    utm_termProp.setAttribute('value', utm_term);
    const utm_contentProp = document.createElement('input');
    utm_contentProp.setAttribute('type', 'hidden');
    utm_contentProp.setAttribute('name', `properties[${utm_contentKey}]`);
    utm_contentProp.setAttribute('value', utm_content);
    return [lcTrackingProp, limechatSessionIDProp, utm_sourceProp, utm_mediumProp, utm_campaignProp, utm_termProp, utm_contentProp];
  }


  function setPixelPropertyToForms(forms){
    const refValue = getLocalStorageWithExpiry(limechatPixelKey);
    const limechatSessionID = getLocalStorageWithExpiry(limechatSessionKey);
    const utm_source = getLocalStorageWithExpiry(utm_sourceKey);
    const utm_medium = getLocalStorageWithExpiry(utm_mediumKey);
    const utm_campaign = getLocalStorageWithExpiry(utm_campaignKey);
    const utm_term = getLocalStorageWithExpiry(utm_termKey);
    const utm_content = getLocalStorageWithExpiry(utm_contentKey);
    if (!refValue || !isRefProvidedByLC(refValue) || !limechatSessionID){
      return;
    }

    if(!utm_source){
      utm_source = '';
    }
    if(!utm_medium){
      utm_medium = '';
    }
    if(!utm_campaign){
      utm_campaign = '';
    }
    if(!utm_term){
      utm_term = '';
    }
    if(!utm_content){
      utm_content = '';
    }

    const [lcTrackingProp, limechatSessionIDProp, utm_sourceProp, utm_mediumProp, utm_campaignProp, utm_termProp, utm_contentProp] = createLCTrackingProps(refValue, limechatSessionID, utm_source, utm_medium, utm_campaign, utm_term, utm_content);
    for (const form of forms) {
      form.appendChild(lcTrackingProp);
      form.appendChild(limechatSessionIDProp);
      form.appendChild(utm_sourceProp);
      form.appendChild(utm_mediumProp);
      form.appendChild(utm_campaignProp);
      form.appendChild(utm_termProp);
      form.appendChild(utm_contentProp);
    }
  }

  function init(){
    const [referredByLC, refToken, utm_source, utm_medium, utm_campaign, utm_term, utm_content] = isReferredByLC();
    if(referredByLC) {
      setLocalStorageWithExpiry(limechatPixelKey, refToken, conversionExpiry);
      setLocalStorageWithExpiry(limechatSessionKey, nanoid(), conversionExpiry);
    }
    if(utm_source) {
      setLocalStorageWithExpiry(utm_sourceKey, utm_source, conversionExpiry);
    }
    if(utm_medium) {
      setLocalStorageWithExpiry(utm_mediumKey, utm_medium, conversionExpiry);
    }
    if(utm_campaign) {
      setLocalStorageWithExpiry(utm_campaignKey, utm_campaign, conversionExpiry);
    }
    if(utm_term) {
      setLocalStorageWithExpiry(utm_termKey, utm_term, conversionExpiry);
    }
    if(utm_content) {
      setLocalStorageWithExpiry(utm_contentKey, utm_content, conversionExpiry);
    }
  }

  init();
  const cartForms = document.querySelectorAll('form[action="/cart/add"]');
  if (cartForms.length > 0 && getLocalStorageWithExpiry(limechatPixelKey)) {
    setPixelPropertyToForms(cartForms);
  }
})();
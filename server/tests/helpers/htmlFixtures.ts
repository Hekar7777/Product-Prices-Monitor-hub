/**
 * Mocked Flipkart HTML responses.
 *
 * These are hand-written approximations of the page shapes the extractor must
 * handle. Tests parse these instead of hitting flipkart.com, so the suite is
 * deterministic and does not put load on a third-party site.
 */

/** A page whose price lives in a schema.org JSON-LD block. */
export function jsonLdPage(options: {
  name?: string;
  price?: number | string;
  mrp?: number;
  availability?: string;
  seller?: string;
  image?: string;
} = {}): string {
  const {
    name = 'Apple iPhone 16 (Black, 128 GB)',
    price = 69999,
    mrp = 79900,
    availability = 'http://schema.org/InStock',
    seller = 'SuperComNet',
    image = 'https://rukminim2.flixcart.com/image/416/416/iphone.jpeg',
  } = options;

  return `<!doctype html>
<html><head>
<title>${name} - Buy Online at Flipkart</title>
<meta property="og:title" content="${name}" />
<meta property="og:image" content="${image}" />
<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Product',
  name,
  image: [image],
  offers: {
    '@type': 'AggregateOffer',
    priceCurrency: 'INR',
    lowPrice: price,
    highPrice: mrp,
    availability,
    seller: { '@type': 'Organization', name: seller },
  },
})}
</script>
</head><body><div id="container">Product page</div></body></html>`;
}

/** A page with no JSON-LD, where the price must come from class selectors. */
export function domPage(options: {
  name?: string;
  price?: string;
  mrp?: string;
  seller?: string;
} = {}): string {
  const {
    name = 'Sony Bravia 139 cm (55 inch) 4K Ultra HD LED Smart TV',
    price = '₹52,490',
    mrp = '₹79,900',
    seller = 'Sony Exclusive',
  } = options;

  return `<!doctype html>
<html><head><title>${name}</title></head>
<body>
  <div class="C7fEHH">
    <h1 class="_6EBuvT"><span class="VU-ZEz">${name}</span></h1>
    <div class="hl05eU">
      <div class="Nx9bqj CxhGGd">${price}</div>
      <div class="yRaY8j A6+E6v">${mrp}</div>
      <div class="UkUFwK"><span>34% off</span></div>
    </div>
    <img class="DByuf4" src="https://rukminim2.flixcart.com/image/{@width}/{@height}/tv.jpeg" />
    <div id="sellerName"><span><span>${seller}</span></span></div>
  </div>
</body></html>`;
}

/** Older Flipkart markup generation, to prove the fallback selectors work. */
export function legacyDomPage(price = '₹1,29,900'): string {
  return `<!doctype html>
<html><head><title>Legacy product</title></head>
<body>
  <span class="B_NuCI">MacBook Air M2 (Midnight, 256 GB)</span>
  <div class="_30jeq3 _16Jk6d">${price}</div>
  <div class="_3I9_wc _2p6lqe">₹1,49,900</div>
  <img class="_396cs4" src="//rukminim2.flixcart.com/image/416/416/mac.jpeg" />
</body></html>`;
}

/** Price only present in the hydration state blob. */
export function initialStatePage(price = 34999): string {
  const state = {
    pageDataV4: {
      page: {
        pageData: {
          pageContext: {
            titles: { title: 'OnePlus Nord CE4 (Dark Chrome, 256 GB)' },
            sellerName: 'OnePlus Store',
          },
        },
      },
    },
    priceInfo: {
      finalPrice: { value: price, currency: 'INR', decimalValue: String(price) },
      mrp: { value: 39999, currency: 'INR' },
    },
    imageUrl: { value: 'https://rukminim2.flixcart.com/image/{@width}/{@height}/nord.jpeg' },
  };

  return `<!doctype html>
<html><head><title>OnePlus Nord CE4</title></head>
<body><div id="container"></div>
<script>window.__INITIAL_STATE__ = ${JSON.stringify(state)};</script>
</body></html>`;
}

/** An anti-bot verification interstitial. */
export function captchaPage(): string {
  return `<!doctype html>
<html><head><title>Robot Check</title></head>
<body>
  <h1>Are you a human?</h1>
  <p>Please complete the security check to continue.</p>
  <div id="px-captcha"></div>
</body></html>`;
}

/** Flipkart's "page not found" shell. */
export function removedPage(): string {
  return `<!doctype html>
<html><head><title>404 - Page Not Found</title></head>
<body><h1>Unfortunately, the page you are looking for cannot be found.</h1></body></html>`;
}

/** A real product page that is sold out and shows no selling price. */
export function soldOutPage(): string {
  return `<!doctype html>
<html><head><title>Google Pixel 9 Pro</title></head>
<body>
  <h1><span class="VU-ZEz">Google Pixel 9 Pro (Obsidian, 256 GB)</span></h1>
  <div class="_16FRp0">Sold Out</div>
  <div class="_1dVbu9">This item is currently out of stock</div>
</body></html>`;
}

/** A product page that rendered a title but no price at all. */
export function noPricePage(): string {
  return `<!doctype html>
<html><head><title>Samsung Galaxy S24</title></head>
<body>
  <h1><span class="VU-ZEz">Samsung Galaxy S24 (Onyx Black, 256 GB)</span></h1>
  <div class="skeleton-loader">Loading price…</div>
</body></html>`;
}

/** Not a product page at all. */
export function garbagePage(): string {
  return '<!doctype html><html><body><p>hello</p></body></html>';
}

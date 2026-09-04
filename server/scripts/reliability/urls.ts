/**
 * Representative Flipkart product URLs for the reliability diagnostic.
 *
 * Chosen to span several categories (phones, laptops, TVs, footwear, audio,
 * appliances) since Flipkart serves different templates for different
 * categories and a monitor that only ever sees phones would not tell us much
 * about the other product types users actually track. Every URL below was
 * confirmed live (returns a real product page) at the time this tool was
 * written; Flipkart listings do get delisted over time, so `PRODUCT_REMOVED`
 * results for a specific URL after a while are expected and are not
 * themselves evidence of a fetcher bug - swap in a fresh URL from the same
 * category if that happens.
 *
 * Override this list entirely with `--urls-file <path>` pointing at a JSON
 * file containing `[{ "url": "...", "label": "..." }, ...]`.
 */
export interface TestUrl {
  url: string;
  label: string;
}

export const DEFAULT_TEST_URLS: TestUrl[] = [
  { url: 'https://www.flipkart.com/apple-iphone-16-white-128-gb/p/itm7c0281cd247be', label: 'Mobile - Apple iPhone 16' },
  {
    url: 'https://www.flipkart.com/vivo-x200t-stellar-black-512-gb/p/itm1b8452d68859b?pid=MOBHJK5MWVU36Z9H',
    label: 'Mobile - vivo X200T',
  },
  {
    url: 'https://www.flipkart.com/asus-expertbook-p3-intel-core-ultra-7-255h-16-gb-512-gb-ssd-windows-11-home-p3406ccap-ly0161ws-thin-light-laptop/p/itm4e82eadf48819',
    label: 'Laptop - ASUS ExpertBook P3',
  },
  {
    url: 'https://www.flipkart.com/apple-macbook-neo-a18-pro-2026-pro-8-gb-512-gb-ssd-tahoe-mhfc4hn-a/p/itm810de98c2fd1b',
    label: 'Laptop - Apple MacBook',
  },
  {
    url: 'https://www.flipkart.com/lg-80-cm-32-inch-hd-ready-led-smart-webos-tv-alpha5-gen5-ai-processor-magic-remote/p/itm0a6335b3213bb',
    label: 'TV - LG 32" HD',
  },
  {
    url: 'https://www.flipkart.com/sony-premium-bravia-138-8-cm-55-inch-ultra-hd-4k-led-smart-google-tv/p/itmded5c6316427f',
    label: 'TV - Sony Bravia 55"',
  },
  {
    url: 'https://www.flipkart.com/samsung-80-cm-32-inch-hd-ready-led-smart-tizen-tv-bezel-free-design/p/itm33b1495b9e937',
    label: 'TV - Samsung 32" Tizen',
  },
  { url: 'https://www.flipkart.com/puma-amaze-runner-sneakers-men/p/itm41b94e9216124', label: 'Footwear - PUMA sneakers' },
  { url: 'https://www.flipkart.com/nike-run-defy-running-shoes-men/p/itm080e98ba593c6', label: 'Footwear - Nike running shoes' },
  {
    url: 'https://www.flipkart.com/adidas-leagueone-st-m-running-shoes-men/p/itm29de42642ed03',
    label: 'Footwear - adidas running shoes',
  },
  {
    url: 'https://www.flipkart.com/boat-nirvana-ion-120-hours-playback-crystal-bionic-sound-hifi-dsp-5-bluetooth/p/itmdae6642f66385',
    label: 'Audio - boAt Nirvana Ion',
  },
  {
    url: 'https://www.flipkart.com/boat-airdopes-441-tws-ear-buds-iwp-technology-bluetooth-headset/p/itm7e8ee60af92ce',
    label: 'Audio - boAt Airdopes 441',
  },
  {
    url: 'https://www.flipkart.com/samsung-8-kg-fully-automatic-front-load-washing-machine-in-built-heater-black-grey/p/itmd2e3408c6a570',
    label: 'Appliance - Samsung washing machine',
  },
  {
    url: 'https://www.flipkart.com/lg-8-kg-5-star-ai-direct-drive-technology-steam-6-motion-dd-fully-automatic-front-load-washing-machine-black/p/itm8c7244dbd53db',
    label: 'Appliance - LG washing machine',
  },
  {
    url: 'https://www.flipkart.com/godrej-7-kg-fully-automatic-top-load-grey/p/itm9e331727633af',
    label: 'Appliance - Godrej washing machine',
  },
];

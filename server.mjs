#!/usr/bin/env node
/**
 * Hudson Window — server
 *
 * This file exists for exactly one reason: the two data sources cannot be
 * reached from a browser.
 *
 *   - aisstream.io forbids direct browser websocket connections.
 *   - The ADS-B aggregators send no CORS headers.
 *
 * So the server holds the AIS socket, proxies the ADS-B polls, normalises both
 * into one contact shape, and serves public/ as static files. It has no
 * dependencies and no build step. Node 22+.
 *
 *   node server.mjs             live data (needs AISSTREAM_KEY for vessels)
 *   node server.mjs --demo      synthetic traffic, zero network
 *
 * All geometry lives in the front end. This file does transport and merging.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const DEMO = process.argv.includes('--demo');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const num = (v, fallback) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

const PORT = num(process.env.PORT, 8808);

/**
 * The observer. These are also sent to the front end so that the server-side
 * query origin and the client-side geometry origin can never drift apart.
 *
 * eyeAltM is height above MEAN SEA LEVEL, not above ground, because aircraft
 * altitudes are above sea level too and the elevation angle needs both sides
 * of the subtraction on the same datum. Newport sits close to sea level, so
 * "floor height + a couple of metres" is a good approximation here.
 */
const OBSERVER = {
  lat: num(process.env.HW_LAT, 40.7267),
  lon: num(process.env.HW_LON, -74.0345),
  eyeAltM: num(process.env.HW_EYE_ALT_M, 40),
};

/** Aircraft are high, so they are worth fetching from far away. Nautical miles. */
const AIRCRAFT_RADIUS_NM = num(process.env.HW_AIR_RADIUS_NM, 30);

/**
 * Ships are not. The geometric horizon from 40 m up is about 23 km, and a
 * bigger AIS bounding box in New York Harbour means a firehose of vessels you
 * could never see. Kilometres.
 */
const VESSEL_RADIUS_KM = num(process.env.HW_SEA_RADIUS_KM, 14);

/**
 * Deliberate. adsb.lol, adsb.fi and airplanes.live are volunteer-run and rate
 * limited to roughly one request per second. This cache collapses every
 * browser poll inside the window into a single upstream call. Do not remove it.
 */
const AIRCRAFT_CACHE_MS = num(process.env.HW_CACHE_MS, 4000);

/** Drop a vessel from the table after this long without a position report. */
const VESSEL_TTL_MS = num(process.env.HW_VESSEL_TTL_MS, 12 * 60 * 1000);

const AISSTREAM_KEY = process.env.AISSTREAM_KEY || '';

const FT_TO_M = 0.3048;
const KM_PER_DEG_LAT = 110.574;

// ---------------------------------------------------------------------------
// Aircraft: polled HTTP, with fallbacks and a shared cache
// ---------------------------------------------------------------------------

/**
 * All three serve readsb-flavoured JSON with the same per-aircraft field names,
 * which is what makes falling back between them cheap. They do NOT agree on the
 * name of the array that holds them: adsb.lol says `ac`, adsb.fi says
 * `aircraft`. Read both.
 *
 * adsb.fi is the only one of the three that fills in `desc` and `ownOp`, so a
 * fallback fetch actually identifies aircraft better than the primary does.
 *
 * airplanes.live requires you to contact them and describe your project before
 * it will serve you; until then it answers HTTP 200 with an `error` object.
 * That is handled below, so leaving it in the list costs nothing.
 */
const AIRCRAFT_SOURCES = [
  {
    name: 'adsb.lol',
    url: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}`,
  },
  {
    name: 'adsb.fi',
    url: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
  },
  {
    name: 'airplanes.live',
    url: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}`,
  },
];

const aircraftCache = {
  at: 0,
  contacts: [],
  source: null,
  error: null,
  /** In-flight promise, so concurrent requests share one upstream call. */
  pending: null,
};

/**
 * Start at whichever source last worked rather than always hammering the first
 * one. With three sources each limited to 1 req/s, sequential-and-sticky is
 * the polite pattern; fanning out in parallel is what gets you blocked.
 */
let preferredSource = 0;

async function fetchAircraft() {
  const now = Date.now();
  if (now - aircraftCache.at < AIRCRAFT_CACHE_MS) return aircraftCache;
  if (aircraftCache.pending) return aircraftCache.pending;

  aircraftCache.pending = (async () => {
    if (DEMO) {
      aircraftCache.at = Date.now();
      aircraftCache.contacts = demoAircraft();
      aircraftCache.source = 'demo';
      aircraftCache.error = null;
      return aircraftCache;
    }

    const errors = [];
    /** A source that answered cleanly but with nothing in it. See below. */
    let emptyFallback = null;

    for (let i = 0; i < AIRCRAFT_SOURCES.length; i++) {
      const index = (preferredSource + i) % AIRCRAFT_SOURCES.length;
      const source = AIRCRAFT_SOURCES[index];
      try {
        const res = await fetch(source.url(OBSERVER.lat, OBSERVER.lon, AIRCRAFT_RADIUS_NM), {
          signal: AbortSignal.timeout(5000),
          headers: { 'user-agent': 'hudson-window/1.0 (personal single-user display)' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();

        // Some of these answer 200 with an error object rather than an error
        // status — airplanes.live does this until you have registered with them.
        if (body && typeof body.error === 'string') throw new Error(body.error.slice(0, 140));

        const raw = Array.isArray(body.ac) ? body.ac : Array.isArray(body.aircraft) ? body.aircraft : null;
        if (raw === null) throw new Error('no aircraft array in response');

        const contacts = raw.map(normaliseAircraft).filter(Boolean);

        // A clean 200 carrying an empty list is not evidence that the sky is
        // empty. It is far more often a source that has quietly stopped covering
        // this area. Remember it as a last resort, but keep looking — and do not
        // make it the preferred source, or one bad answer sticks forever.
        if (contacts.length === 0) {
          if (!emptyFallback) emptyFallback = source.name;
          errors.push(`${source.name}: returned no aircraft`);
          continue;
        }

        preferredSource = index;
        aircraftCache.at = Date.now();
        aircraftCache.contacts = contacts;
        aircraftCache.source = source.name;
        aircraftCache.error = null;
        return aircraftCache;
      } catch (err) {
        errors.push(`${source.name}: ${err.message}`);
      }
    }

    aircraftCache.at = Date.now();

    if (emptyFallback) {
      // Every source that answered, answered empty. Believe it.
      aircraftCache.contacts = [];
      aircraftCache.source = emptyFallback;
      aircraftCache.error = null;
      return aircraftCache;
    }

    // Nothing answered at all. Keep serving the last good contacts and say so,
    // rather than blanking the window — stale traffic beats no traffic.
    aircraftCache.source = null;
    aircraftCache.error = errors.join('; ');
    return aircraftCache;
  })().finally(() => {
    aircraftCache.pending = null;
  });

  return aircraftCache.pending;
}

/**
 * ICAO emitter category. A7 is the only fully reliable rotorcraft signal in the
 * feed, which is why identification keys off it rather than off the type
 * designator or the operator name.
 */
const CATEGORY_CLASS = {
  // These are ICAO weight bands, not roles, and the names here say so. A3 is
  // 75,000-300,000 lb, which is most airliners but also a Gulfstream V, so
  // calling it "airliner" would be wrong about a good fraction of the traffic.
  A1: 'light',
  A2: 'small',
  A3: 'medium',
  A4: 'large',
  A5: 'heavy',
  A6: 'high-performance',
  A7: 'helicopter',
  B1: 'glider',
  B2: 'balloon',
  B4: 'ultralight',
  B6: 'drone',
  B7: 'spacecraft',
};

/**
 * Backup for aircraft transmitting no category, which is common. These are the
 * rotorcraft types that actually fly the Hudson corridor.
 */
const HELICOPTER_TYPES = new Set([
  'A109', 'A119', 'A139', 'A169', 'A189', 'AS50', 'AS55', 'AS65', 'B06', 'B06T',
  'B407', 'B412', 'B429', 'B430', 'B47G', 'EC20', 'EC30', 'EC35', 'EC45', 'EC55',
  'EC75', 'H500', 'H60', 'MD52', 'MD60', 'R22', 'R44', 'R66', 'S269', 'S76',
  'S92', 'UH60', 'AS32', 'AS3B', 'B505', 'B525',
]);

/**
 * ICAO type designator to something a person would recognise.
 *
 * adsb.lol serves no `desc` field, so without this the primary source can only
 * ever tell you "B38M". Covers what actually flies over the lower Hudson:
 * Newark, LaGuardia and JFK airline traffic, Teterboro business jets, and the
 * corridor rotorcraft and light singles.
 */
const TYPE_NAMES = {
  A306: 'Airbus A300-600', A310: 'Airbus A310', A319: 'Airbus A319', A320: 'Airbus A320',
  A20N: 'Airbus A320neo', A321: 'Airbus A321', A21N: 'Airbus A321neo', A332: 'Airbus A330-200',
  A333: 'Airbus A330-300', A339: 'Airbus A330-900', A343: 'Airbus A340-300', A359: 'Airbus A350-900',
  A35K: 'Airbus A350-1000', A388: 'Airbus A380',
  B712: 'Boeing 717', B733: 'Boeing 737-300', B737: 'Boeing 737-700', B738: 'Boeing 737-800',
  B739: 'Boeing 737-900', B38M: 'Boeing 737 MAX 8', B39M: 'Boeing 737 MAX 9', B752: 'Boeing 757-200',
  B753: 'Boeing 757-300', B762: 'Boeing 767-200', B763: 'Boeing 767-300', B764: 'Boeing 767-400',
  B772: 'Boeing 777-200', B77L: 'Boeing 777-200LR', B77W: 'Boeing 777-300ER', B788: 'Boeing 787-8',
  B789: 'Boeing 787-9', B78X: 'Boeing 787-10', B744: 'Boeing 747-400', B748: 'Boeing 747-8',
  CRJ2: 'Bombardier CRJ200', CRJ7: 'Bombardier CRJ700', CRJ9: 'Bombardier CRJ900',
  E135: 'Embraer ERJ-135', E145: 'Embraer ERJ-145', E170: 'Embraer E170', E75L: 'Embraer E175',
  E75S: 'Embraer E175', E190: 'Embraer E190', E195: 'Embraer E195', E290: 'Embraer E190-E2',
  DH8D: 'Dash 8 Q400', AT76: 'ATR 72', B462: 'BAe 146',
  BCS1: 'Airbus A220-100', BCS3: 'Airbus A220-300',
  GA5C: 'Gulfstream G500', GA6C: 'Gulfstream G600', GA7C: 'Gulfstream G700',
  GLF4: 'Gulfstream IV', GLF5: 'Gulfstream V', GLF6: 'Gulfstream G650', G280: 'Gulfstream G280',
  CL30: 'Challenger 300', CL35: 'Challenger 350', CL60: 'Challenger 600',
  GL5T: 'Global 5000', GL7T: 'Global 7500', GLEX: 'Global Express',
  C25A: 'Citation CJ2', C25B: 'Citation CJ3', C25C: 'Citation CJ4', C56X: 'Citation Excel',
  C68A: 'Citation Latitude', C700: 'Citation Longitude', C750: 'Citation X',
  E55P: 'Phenom 300', E50P: 'Phenom 100',
  E545: 'Embraer Praetor 500', E550: 'Embraer Legacy 500', E35L: 'Embraer Legacy 600',
  P180: 'Piaggio Avanti', CL64: 'Challenger 650',
  LJ45: 'Learjet 45', LJ60: 'Learjet 60', H25B: 'Hawker 800', F2TH: 'Falcon 2000',
  FA7X: 'Falcon 7X', FA8X: 'Falcon 8X', F900: 'Falcon 900',
  PC12: 'Pilatus PC-12', PC24: 'Pilatus PC-24', TBM9: 'Daher TBM 900', BE20: 'King Air 200',
  BE9L: 'King Air 90', BE40: 'Beechjet 400', C208: 'Cessna Caravan',
  C172: 'Cessna 172', C182: 'Cessna 182', SR20: 'Cirrus SR20', SR22: 'Cirrus SR22',
  P28A: 'Piper Cherokee', DA40: 'Diamond DA40', DA42: 'Diamond DA42',
  S76: 'Sikorsky S-76', S92: 'Sikorsky S-92', EC35: 'Airbus H135', EC30: 'Airbus H130',
  EC45: 'Airbus H145', AS50: 'Airbus AS350', A109: 'Leonardo A109', A139: 'Leonardo AW139',
  B407: 'Bell 407', B429: 'Bell 429', B06: 'Bell JetRanger', R44: 'Robinson R44', R66: 'Robinson R66',
  MD11: 'McDonnell Douglas MD-11', B190: 'Beech 1900',
};

/**
 * ICAO airline designator — the first three letters of a flight callsign — to
 * the operator. adsb.lol serves no `ownOp` either.
 */
const OPERATORS = {
  AAL: 'American', UAL: 'United', DAL: 'Delta', SWA: 'Southwest', JBU: 'JetBlue',
  ASA: 'Alaska', NKS: 'Spirit', FFT: 'Frontier', AAY: 'Allegiant', SCX: 'Sun Country',
  RPA: 'Republic', EDV: 'Endeavor', GJS: 'GoJet', SKW: 'SkyWest', ENY: 'Envoy',
  PDT: 'Piedmont', JIA: 'PSA', QXE: 'Horizon', ASH: 'Mesa',
  FDX: 'FedEx', UPS: 'UPS', GTI: 'Atlas Air', ABX: 'ABX Air', CKS: 'Kalitta',
  ACA: 'Air Canada', WJA: 'WestJet', TSC: 'Air Transat', POE: 'Porter',
  BAW: 'British Airways', VIR: 'Virgin Atlantic', DLH: 'Lufthansa', AFR: 'Air France',
  KLM: 'KLM', SWR: 'Swiss', AUA: 'Austrian', SAS: 'SAS', FIN: 'Finnair',
  IBE: 'Iberia', TAP: 'TAP', EIN: 'Aer Lingus', ITY: 'ITA Airways', LOT: 'LOT',
  THY: 'Turkish', ELY: 'El Al', UAE: 'Emirates', QTR: 'Qatar', ETD: 'Etihad',
  SVA: 'Saudia', MSR: 'EgyptAir', ETH: 'Ethiopian', RAM: 'Royal Air Maroc',
  AIC: 'Air India', SIA: 'Singapore', CPA: 'Cathay', JAL: 'JAL', ANA: 'ANA',
  KAL: 'Korean', AAR: 'Asiana', CCA: 'Air China', CES: 'China Eastern', CSN: 'China Southern',
  AMX: 'Aeroméxico', VOI: 'Volaris', CMP: 'Copa', AVA: 'Avianca', LAN: 'LATAM',
  TAM: 'LATAM Brasil', ARG: 'Aerolíneas Argentinas', AZU: 'Azul', GLO: 'GOL',
  BWA: 'Caribbean', JBL: 'JetBlue', CAY: 'Cayman', BHS: 'Bahamasair',
  EJA: 'NetJets', LXJ: 'Flexjet', JTL: 'Jet Linx', OPT: 'Flight Options', VTE: 'Vista',
  LFT: 'Wheels Up', TFF: 'Blade',
};

/**
 * Freight operators. Without this the front end cheerfully describes a FedEx
 * 767 as "a FedEx passenger jet".
 */
const CARGO_OPERATORS = new Set(['FDX', 'UPS', 'GTI', 'ABX', 'CKS']);

/**
 * Business jets. ICAO weight category cannot tell these apart from airliners —
 * a Gulfstream G650 lands in A3 alongside a 737 — and Teterboro is close
 * enough that a good share of what crosses this window is one of these.
 */
const BUSINESS_JETS = new Set([
  'GLF3', 'GLF4', 'GLF5', 'GLF6', 'G280', 'GLEX', 'GL5T', 'GL7T',
  'GA5C', 'GA6C', 'GA7C',
  'CL30', 'CL35', 'CL60', 'CL64',
  'C25A', 'C25B', 'C25C', 'C500', 'C510', 'C525', 'C550', 'C560', 'C56X', 'C650', 'C680', 'C68A', 'C700', 'C750',
  'E50P', 'E55P', 'E545', 'E550',
  'LJ31', 'LJ35', 'LJ40', 'LJ45', 'LJ55', 'LJ60', 'LJ75',
  'H25B', 'H25C', 'BE40', 'PRM1',
  'F2TH', 'FA7X', 'FA8X', 'F900', 'F2000', 'FA50',
  'PC24', 'HA4T', 'SF50',
]);

/** Charter and fractional-ownership fleets. Not airlines, whatever they fly. */
const CHARTER_OPERATORS = new Set(['EJA', 'LXJ', 'JTL', 'OPT', 'VTE', 'LFT']);

/**
 * What a person would call it, without weight bands or type designators.
 *
 * Note that flying for a scheduled airline settles the question before weight
 * does: a CRJ700 is category A2, but "a GoJet small jet" is not what anyone
 * would say about a regional airliner full of passengers.
 */
function plainKindFor(klass, type, airlineCode) {
  if (klass === 'helicopter') return 'helicopter';
  if (klass === 'glider') return 'glider';
  if (klass === 'balloon') return 'balloon';
  if (klass === 'drone') return 'drone';
  if (airlineCode && CARGO_OPERATORS.has(airlineCode)) return 'cargo plane';
  if (type && BUSINESS_JETS.has(type)) return 'private jet';
  if (airlineCode && CHARTER_OPERATORS.has(airlineCode)) return 'private jet';
  if (airlineCode && OPERATORS[airlineCode]) return 'passenger jet';
  if (klass === 'light') return 'small plane';
  if (klass === 'small') return 'small jet';
  return 'passenger jet';
}

/**
 * One true thing about each type, for someone who likes knowing them.
 *
 * Grouped by family because a fact about the 737 is a fact about all of them.
 * Everything here is a well-established, checkable claim — no folklore.
 */
const FACT_GROUPS = [
  // Light aircraft
  [['C172'], 'More Cessna 172s have been built than any other aircraft ever: over 44,000 since 1956.'],
  [['C182'], "The 182 is the 172's heavier cousin, with a constant-speed propeller and a much better useful load."],
  [['SR20', 'SR22'], 'Every Cirrus leaves the factory with a parachute for the whole aeroplane, packed behind the cabin.'],
  [['P28A'], "Piper's Cherokee wing is a constant-chord slab nicknamed the Hershey bar. Cheap to build, and very forgiving."],
  [['DA40', 'DA42'], 'Diamond builds these from carbon composite rather than aluminium, which is why the shape is so smooth.'],
  [['BE20', 'BE9L', 'B190'], 'The King Air has been in continuous production since 1964. Few civil aircraft have lasted as long.'],
  [['PC12'], 'A single turboprop with a cargo door, cleared for gravel and grass strips. Air ambulances love it for exactly that.'],
  [['TBM9'], 'One of the fastest single-engine turboprops in production. It cruises not far off regional jet speed.'],
  [['C208'], 'The Caravan is the workhorse of small cargo and island hops; plenty fly with the seats taken out entirely.'],
  // Airliners
  [['B733', 'B737', 'B738', 'B739', 'B712'], 'The 737 is the best-selling jetliner ever built, with more than 11,000 delivered since 1967.'],
  [['B38M', 'B39M'], 'You can spot a MAX by its split-tip winglets, which point up and down at the same time.'],
  [['B752', 'B753'], 'The 757 has so much thrust for its size that crews call it a rocket. It climbs out steeply even when full.'],
  [['B762', 'B763', 'B764'], "The 767 is what opened up twin-engine ocean crossings; before it, two engines weren't trusted that far from land."],
  [['B772', 'B77L', 'B77W'], 'The 777 was the first airliner designed entirely on computer. No physical mock-up was ever built.'],
  [['B788', 'B789', 'B78X'], "The Dreamliner's fuselage is mostly carbon fibre, which lets it hold a more humid, lower cabin altitude than aluminium can."],
  [['B744', 'B748'], "The 747's hump is there so the nose could hinge up for freight, in case supersonic jets made it obsolete for passengers."],
  [['A319', 'A320', 'A321'], 'The A320 was the first airliner with digital fly-by-wire and a sidestick instead of a control yoke.'],
  [['A20N', 'A21N'], 'The neo is simply new engines. The giveaway is the much larger fan and the curved sharklets.'],
  [['A332', 'A333', 'A339'], 'The A330 was built alongside the four-engined A340 and shares its wing and fuselage cross-section.'],
  [['A359', 'A35K'], "The A350's wings are carbon fibre and flex several metres at the tip in flight."],
  [['A388'], 'The A380 is the only full-length double-decker airliner ever built.'],
  [['BCS1', 'BCS3'], "The A220 began life as Bombardier's C Series; Airbus took the programme over in 2018."],
  [['CRJ2', 'CRJ7', 'CRJ9'], 'The CRJ started as a stretched Challenger business jet. The nose is essentially unchanged.'],
  [['E135', 'E145'], 'The ERJ-145 seats one-and-two across, so nobody aboard has a middle seat.'],
  [['E170', 'E75L', 'E75S', 'E190', 'E195', 'E290'], "Embraer's E-Jets are two-and-two across, which is why they feel roomier than a regional jet their size."],
  [['DH8D'], 'The Q in Q400 stands for Quiet. It has active noise cancellation built into the cabin.'],
  [['AT76'], 'ATRs keep their propellers on purpose: under about 300 miles a turboprop burns far less fuel than a jet.'],
  [['B462'], 'Four small engines and no thrust reversers at all. It was nicknamed the Whisperjet for how quietly it flew.'],
  [['MD11'], 'You can tell an MD-11 from a DC-10 by the winglets, and its third engine is buried in the tail.'],
  // Business jets
  [['GLF4', 'GLF5', 'GLF6', 'GA5C', 'GA6C', 'GA7C'], 'The G650 cruises at Mach 0.85 and tops out near Mach 0.925, among the fastest civil aircraft flying.'],
  [['GLEX', 'GL5T', 'GL7T'], "Bombardier's Global series can fly New York to Hong Kong without stopping."],
  [['CL30', 'CL35', 'CL60', 'CL64'], 'The Challenger has a flat floor and a cabin tall enough for most people to stand up in, unusual at this size.'],
  [['C25A', 'C25B', 'C25C', 'C56X', 'C68A', 'C700', 'C750', 'C560', 'C680'], "Cessna's Citations are the most numerous family of business jets in the world."],
  [['E50P', 'E55P'], 'The Phenom 300 has been the most-delivered light jet in the world for more than a decade.'],
  [['LJ31', 'LJ35', 'LJ45', 'LJ60', 'LJ75'], 'Bill Lear, who built the first Learjet, also invented the eight-track tape cartridge.'],
  [['H25B', 'H25C'], "The Hawker traces back to the de Havilland 125 of the 1960s, one of the longest-lived business jet designs."],
  [['F2TH', 'FA7X', 'FA8X', 'F900', 'FA50'], 'Dassault builds Falcons in the same shops as its fighter jets, which is part of why several have three engines.'],
  [['PC24'], 'The PC-24 is the only business jet certified for unpaved runways, with a cargo door built in as standard.'],
  [['C750'], 'The Citation X held the title of fastest civil aircraft in the world for years, at Mach 0.935.'],
  [['E545', 'E550', 'E35L'], "Embraer's Legacy 500 was the first midsize business jet with full fly-by-wire controls."],
  [['P180'], 'The Avanti has three lifting surfaces and pusher propellers mounted behind the wing. It is the fastest turboprop in production.'],
  // Rotorcraft
  [['S76'], "The S-76 was Sikorsky's first helicopter designed from scratch for civilians, largely to fly crews out to oil rigs."],
  [['S92'], 'Built for offshore work, the S-92 carries flotation gear and life rafts as standard equipment.'],
  [['EC35', 'EC45'], 'The H135 is the most common air-ambulance helicopter in Europe. The shrouded tail rotor is the giveaway.'],
  [['EC30'], 'Its fenestron, a tail rotor enclosed in a duct, makes the H130 quiet enough for the Grand Canyon tour fleet.'],
  [['AS50', 'AS55'], 'An AS350 landed on the summit of Everest in 2005, still the highest helicopter landing ever made.'],
  [['A109', 'A119'], 'Agusta built the A109 for speed. It was one of the first light twins with retractable landing gear.'],
  [['A139', 'A169', 'A189'], 'The AW139 is the standard medium twin for offshore crew changes and search-and-rescue.'],
  [['B407', 'B429', 'B430', 'B505', 'B525'], "The 407 is a LongRanger fitted with a four-blade rotor, which made it markedly smoother."],
  [['B06', 'B06T', 'B47G'], 'The JetRanger is the helicopter most people picture. It flew traffic and news reports for decades.'],
  [['R22', 'R44'], "Robinson's R44 is the best-selling civil helicopter of the past thirty years, and much the cheapest way into rotors."],
  [['R66'], 'The R66 is the turbine R44, with the fuel tank moved to free up a proper luggage compartment.'],
];

const AIRCRAFT_FACTS = Object.fromEntries(
  FACT_GROUPS.flatMap(([types, fact]) => types.map((t) => [t, fact])),
);

/** Rough span or length in metres, used for angular sizing in the window pane. */
const CLASS_SIZE_M = {
  helicopter: 14,
  light: 11,
  small: 20,
  medium: 35,
  large: 38,
  heavy: 60,
  'high-performance': 15,
  glider: 15,
  balloon: 20,
  ultralight: 9,
  drone: 6,
  spacecraft: 20,
  unknown: 20,
};

function normaliseAircraft(ac) {
  const lat = Number(ac.lat);
  const lon = Number(ac.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // alt_baro is the string "ground" for surface traffic in every readsb-derived
  // feed. Doing arithmetic on it yields NaN and the contact silently vanishes.
  const onGround = ac.alt_baro === 'ground' || ac.alt_geom === 'ground';

  // Prefer geometric altitude. alt_baro is referenced to 29.92 inHg rather than
  // to sea level, and on a low-pressure day that is worth several hundred feet
  // — which matters a great deal for the helicopter traffic at 1000 ft.
  let altFt = null;
  let altSource = null;
  if (!onGround) {
    if (Number.isFinite(Number(ac.alt_geom))) {
      altFt = Number(ac.alt_geom);
      altSource = 'geom';
    } else if (Number.isFinite(Number(ac.alt_baro))) {
      altFt = Number(ac.alt_baro);
      altSource = 'baro';
    }
  }

  const category = typeof ac.category === 'string' ? ac.category.toUpperCase() : null;
  const type = typeof ac.t === 'string' ? ac.t.toUpperCase().trim() : null;

  let klass = (category && CATEGORY_CLASS[category]) || null;
  if (!klass && type && HELICOPTER_TYPES.has(type)) klass = 'helicopter';
  if (!klass) klass = 'unknown';

  const callsign = typeof ac.flight === 'string' ? ac.flight.trim() : '';
  const reg = typeof ac.r === 'string' ? ac.r.trim() : '';

  /*
   * The local table wins over the feed's own `desc`. adsb.fi supplies one, but
   * SHOUTING — "BOEING 737-800", "PIPER PA-28R-180/200/201" — which reads badly
   * as a headline. Where the table has no entry, tidy the feed's version:
   * title-case the all-caps words, but leave anything containing a digit and
   * anything short alone, so model codes and MAX and XLS survive intact.
   */
  const tidy = (d) => d && d.split(/\s+/).map((w) =>
    /\d/.test(w) || w.length <= 3 || w !== w.toUpperCase()
      ? w
      : w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
  const typeName = (type && TYPE_NAMES[type]) || tidy(ac.desc) || type || null;
  // A flight callsign is three letters then digits. A registration used as a
  // callsign (N417AW) is not, and must not be read as an airline code.
  const airlineCode = /^[A-Z]{3}\d/.test(callsign) ? callsign.slice(0, 3) : null;

  /*
   * The airline table beats `ownOp`, which is the REGISTERED OWNER and is very
   * often a leasing trust: adsb.fi reports American Airlines flight AAL1942 as
   * owned by "U S BANK NA TRUSTEE". Good enough for the detail view, useless in
   * a sentence meant for someone glancing out of a window. So `operator` is
   * only ever a name a person would recognise, and is left null otherwise;
   * `ownOp` still reaches the detail view through `sublabel`.
   */
  const operator = (airlineCode ? OPERATORS[airlineCode] : null) || null;

  return {
    kind: 'air',
    id: `air:${ac.hex || reg || callsign}`,
    label: callsign || reg || (ac.hex ? ac.hex.toUpperCase() : 'unknown aircraft'),
    // Kept as separate fields as well as the joined string, so the front end can
    // build a plain-English sentence instead of showing "B738 · Delta".
    typeName,
    operator,
    fact: (type && AIRCRAFT_FACTS[type]) || null,
    cargo: !!(airlineCode && CARGO_OPERATORS.has(airlineCode)),
    plainKind: plainKindFor(klass, type, airlineCode),
    sublabel: [typeName, operator].filter(Boolean).join(' · ') || null,
    klass,
    lat,
    lon,
    altM: altFt === null ? null : altFt * FT_TO_M,
    altSource,
    onGround,
    speedKt: Number.isFinite(Number(ac.gs)) ? Number(ac.gs) : null,
    courseDeg: Number.isFinite(Number(ac.track)) ? Number(ac.track) : null,
    headingDeg: null,
    verticalRateFpm: Number.isFinite(Number(ac.baro_rate))
      ? Number(ac.baro_rate)
      : Number.isFinite(Number(ac.geom_rate))
        ? Number(ac.geom_rate)
        : null,
    sizeM: CLASS_SIZE_M[klass] ?? CLASS_SIZE_M.unknown,
    ageS: Number.isFinite(Number(ac.seen_pos)) ? Number(ac.seen_pos) : null,
    extra: {
      hex: ac.hex || null,
      registration: reg || null,
      type: type || null,
      squawk: ac.squawk || null,
      emergency: ac.emergency && ac.emergency !== 'none' ? ac.emergency : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Routes: where a flight came from and where it is going
// ---------------------------------------------------------------------------

/*
 * ADS-B carries no route at all — it is a position and an identity, nothing
 * more. adsbdb.com maps a callsign to its filed origin and destination, and is
 * free and keyless like the position feeds.
 *
 * It is also a small community service, so this is deliberately frugal: only
 * the aircraft actually named on screen is ever looked up, answers are cached
 * for hours, and "no such callsign" is cached too — otherwise every private
 * flight would be asked about again every few seconds forever.
 *
 * General aviation has no filed route to find. A Cessna pottering up the
 * Hudson will always come back unknown, and that is the honest answer rather
 * than a failure.
 */
const ROUTE_URL = (cs) => `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`;
const ROUTE_TTL_MS = 6 * 60 * 60 * 1000;      // a flight number's route does not move
const ROUTE_MISS_TTL_MS = 60 * 60 * 1000;     // nor does the absence of one
const routeCache = new Map();                 // callsign -> { at, route, pending }

function demoRoute(callsign) {
  const table = {
    UAL2231: { airline: 'United Airlines', from: 'Newark', fromCode: 'EWR', to: 'Denver', toCode: 'DEN' },
    JBU1442: { airline: 'JetBlue', from: 'Boston', fromCode: 'BOS', to: 'Fort Lauderdale', toCode: 'FLL' },
    LXJ402: { airline: 'Flexjet', from: 'Teterboro', fromCode: 'TEB', to: 'Palm Beach', toCode: 'PBI' },
  };
  return table[callsign] || null;
}

async function lookupRoute(callsignRaw) {
  const callsign = String(callsignRaw || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,10}$/.test(callsign)) return null;

  if (DEMO) return demoRoute(callsign);

  const hit = routeCache.get(callsign);
  const now = Date.now();
  if (hit) {
    if (hit.pending) return hit.pending;
    const ttl = hit.route ? ROUTE_TTL_MS : ROUTE_MISS_TTL_MS;
    if (now - hit.at < ttl) return hit.route;
  }

  const pending = (async () => {
    try {
      const res = await fetch(ROUTE_URL(callsign), {
        signal: AbortSignal.timeout(6000),
        headers: { 'user-agent': 'hudson-window/1.0 (personal single-user display)' },
      });
      if (!res.ok) return null;                       // 404 means no such callsign
      const body = await res.json();
      const r = body && body.response && body.response.flightroute;
      if (!r || !r.origin || !r.destination) return null;
      return {
        airline: (r.airline && r.airline.name) || null,
        from: r.origin.municipality || r.origin.name || null,
        fromCode: r.origin.iata_code || r.origin.icao_code || null,
        fromCountry: r.origin.country_name || null,
        to: r.destination.municipality || r.destination.name || null,
        toCode: r.destination.iata_code || r.destination.icao_code || null,
        toCountry: r.destination.country_name || null,
      };
    } catch {
      return null;
    }
  })();

  routeCache.set(callsign, { at: now, route: null, pending });
  const route = await pending;
  routeCache.set(callsign, { at: Date.now(), route, pending: null });
  return route;
}

// ---------------------------------------------------------------------------
// Vessels: one long-lived AIS websocket, merged into a table keyed by MMSI
// ---------------------------------------------------------------------------

/** MMSI (as a string) -> merged vessel record. */
const vessels = new Map();

const aisState = {
  status: DEMO ? 'demo' : AISSTREAM_KEY ? 'connecting' : 'no-key',
  error: null,
  connectedAt: null,
  messages: 0,
};

function vesselBoundingBox() {
  const dLat = VESSEL_RADIUS_KM / KM_PER_DEG_LAT;
  const dLon = VESSEL_RADIUS_KM / (KM_PER_DEG_LAT * Math.cos((OBSERVER.lat * Math.PI) / 180));
  // aisstream wants [[north-west],[south-east]] as [lat, lon] pairs.
  return [
    [OBSERVER.lat + dLat, OBSERVER.lon - dLon],
    [OBSERVER.lat - dLat, OBSERVER.lon + dLon],
  ];
}

/**
 * AIS names arrive padded with '@' and trailing spaces, and a vessel that has
 * only ever sent position reports has no name at all.
 */
function cleanAisText(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/@+/g, '').trim();
  return s.length ? s : null;
}

/**
 * Merge one field into a record only when the incoming value is meaningful.
 *
 * This is the whole reason the vessel table is a merge and not an assignment.
 * Position reports (types 1/2/3/18) carry no name and no ship type; static data
 * (types 5/24) carries those and arrives about every six minutes. A wholesale
 * replace on each position report would wipe the static half within seconds of
 * receiving it.
 */
function mergeField(record, key, value) {
  if (value === null || value === undefined) return;
  if (typeof value === 'number' && !Number.isFinite(value)) return;
  record[key] = value;
}

function upsertVessel(mmsi, patch) {
  const key = String(mmsi);
  const existing = vessels.get(key) || { mmsi: key, firstSeen: Date.now() };
  for (const [k, v] of Object.entries(patch)) mergeField(existing, k, v);
  vessels.set(key, existing);
  return existing;
}

/**
 * AIS ship type codes are decade-encoded. The sub-codes inside 30-59 are
 * individually meaningful; everything else reads off the leading digit.
 */
const SHIP_TYPE_EXACT = {
  30: ['fishing', 'fishing vessel'],
  31: ['tug', 'towing'],
  32: ['tug', 'towing (long/large)'],
  33: ['work', 'dredging or underwater ops'],
  34: ['work', 'diving ops'],
  35: ['military', 'military ops'],
  36: ['sailing', 'sailing vessel'],
  37: ['pleasure', 'pleasure craft'],
  50: ['pilot', 'pilot vessel'],
  51: ['sar', 'search and rescue'],
  52: ['tug', 'tug'],
  53: ['work', 'port tender'],
  54: ['work', 'anti-pollution'],
  55: ['law', 'law enforcement'],
  58: ['sar', 'medical transport'],
  59: ['special', 'special craft'],
};

const SHIP_TYPE_DECADE = {
  2: ['special', 'wing-in-ground craft'],
  4: ['fast', 'high-speed craft'],
  6: ['passenger', 'passenger vessel'],
  7: ['cargo', 'cargo ship'],
  8: ['tanker', 'tanker'],
  9: ['other', 'other'],
};

function classifyVessel(typeCode) {
  const t = Number(typeCode);
  if (!Number.isFinite(t) || t <= 0) return { klass: 'unknown', typeName: null };
  if (SHIP_TYPE_EXACT[t]) {
    const [klass, typeName] = SHIP_TYPE_EXACT[t];
    return { klass, typeName };
  }
  const decade = SHIP_TYPE_DECADE[Math.floor(t / 10)];
  if (decade) return { klass: decade[0], typeName: decade[1] };
  return { klass: 'unknown', typeName: null };
}

/** Fallback length in metres when the vessel has not sent its dimensions. */
const VESSEL_SIZE_M = {
  passenger: 60,
  ferry: 40,
  cargo: 180,
  tanker: 200,
  tug: 30,
  fishing: 20,
  pleasure: 12,
  sailing: 12,
  pilot: 18,
  sar: 25,
  law: 20,
  military: 100,
  work: 40,
  fast: 40,
  special: 30,
  other: 40,
  unknown: 30,
};

function handleAisMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  aisState.messages++;

  const meta = msg.MetaData || {};
  const mmsi = meta.MMSI ?? meta.MMSI_String;
  if (mmsi === undefined || mmsi === null) return;

  const patch = {
    name: cleanAisText(meta.ShipName),
    lastSeen: Date.now(),
  };

  const body = msg.Message || {};

  switch (msg.MessageType) {
    case 'PositionReport':
    case 'StandardClassBPositionReport':
    case 'ExtendedClassBPositionReport': {
      const p = body[msg.MessageType] || {};
      patch.lat = Number.isFinite(Number(p.Latitude)) ? Number(p.Latitude) : null;
      patch.lon = Number.isFinite(Number(p.Longitude)) ? Number(p.Longitude) : null;

      // COG 360 and SOG 102.3 are the AIS "not available" sentinels.
      const cog = Number(p.Cog);
      patch.courseDeg = Number.isFinite(cog) && cog < 360 ? cog : null;
      const sog = Number(p.Sog);
      patch.speedKt = Number.isFinite(sog) && sog < 102.3 ? sog : null;

      // 511 means "heading not available", and most small craft send exactly
      // that. Drawing an arrow from it points the whole fleet due east.
      const hdg = Number(p.TrueHeading);
      patch.headingDeg = Number.isFinite(hdg) && hdg < 360 ? hdg : null;

      if (Number.isFinite(Number(p.NavigationalStatus))) {
        patch.navStatus = Number(p.NavigationalStatus);
      }
      patch.lastPosition = Date.now();
      break;
    }

    case 'ShipStaticData': {
      const s = body.ShipStaticData || {};
      patch.name = cleanAisText(s.Name) || patch.name;
      patch.callSign = cleanAisText(s.CallSign);
      patch.destination = cleanAisText(s.Destination);
      if (Number.isFinite(Number(s.Type))) patch.typeCode = Number(s.Type);
      if (Number.isFinite(Number(s.ImoNumber)) && Number(s.ImoNumber) > 0) {
        patch.imo = Number(s.ImoNumber);
      }
      const d = s.Dimension || {};
      const length = Number(d.A) + Number(d.B);
      if (Number.isFinite(length) && length > 0) patch.lengthM = length;
      break;
    }

    case 'StaticDataReport': {
      // Class B static arrives split across two part messages.
      const s = body.StaticDataReport || {};
      if (s.ReportA) patch.name = cleanAisText(s.ReportA.Name) || patch.name;
      if (s.ReportB) {
        patch.callSign = cleanAisText(s.ReportB.CallSign);
        if (Number.isFinite(Number(s.ReportB.ShipType))) patch.typeCode = Number(s.ReportB.ShipType);
        const d = s.ReportB.Dimension || {};
        const length = Number(d.A) + Number(d.B);
        if (Number.isFinite(length) && length > 0) patch.lengthM = length;
      }
      break;
    }

    default:
      return;
  }

  upsertVessel(mmsi, patch);
}

function connectAis() {
  if (DEMO) return;
  if (!AISSTREAM_KEY) {
    aisState.status = 'no-key';
    aisState.error = 'AISSTREAM_KEY is not set, so vessels are unavailable. Aircraft still work.';
    console.warn('[ais] AISSTREAM_KEY is not set, running without vessels.');
    return;
  }
  if (typeof WebSocket !== 'function') {
    aisState.status = 'error';
    aisState.error = 'No global WebSocket. Node 22.4 or newer is required.';
    console.error('[ais] no global WebSocket, Node 22.4+ required.');
    return;
  }

  let attempt = 0;

  const open = () => {
    aisState.status = 'connecting';
    const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');

    ws.addEventListener('open', () => {
      attempt = 0;
      aisState.status = 'connected';
      aisState.error = null;
      aisState.connectedAt = Date.now();
      ws.send(
        JSON.stringify({
          APIKey: AISSTREAM_KEY,
          BoundingBoxes: [vesselBoundingBox()],
          FilterMessageTypes: [
            'PositionReport',
            'StandardClassBPositionReport',
            'ExtendedClassBPositionReport',
            'ShipStaticData',
            'StaticDataReport',
          ],
        }),
      );
      console.log('[ais] connected');
    });

    ws.addEventListener('message', (ev) => {
      handleAisMessage(typeof ev.data === 'string' ? ev.data : String(ev.data));
    });

    ws.addEventListener('error', () => {
      // The close handler does the reconnecting; this only records the reason.
      aisState.error = 'websocket error';
    });

    ws.addEventListener('close', (ev) => {
      aisState.status = 'reconnecting';
      // aisstream closes with a message body on a bad key. Worth surfacing,
      // because otherwise it just looks like a flaky connection.
      if (ev.reason) aisState.error = ev.reason;
      const delay = Math.min(30000, 1000 * 2 ** attempt++);
      console.warn(`[ais] disconnected (${ev.reason || ev.code}), retrying in ${delay}ms`);
      setTimeout(open, delay);
    });
  };

  open();
}

function currentVessels() {
  if (DEMO) return demoVessels();

  const now = Date.now();
  const out = [];
  for (const [mmsi, v] of vessels) {
    if (now - (v.lastSeen || 0) > VESSEL_TTL_MS) {
      vessels.delete(mmsi);
      continue;
    }
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) continue;
    out.push(vesselToContact(v));
  }
  return out;
}

function vesselToContact(v) {
  const { klass, typeName } = classifyVessel(v.typeCode);
  return {
    kind: 'water',
    id: `sea:${v.mmsi}`,
    label: v.name || `MMSI ${v.mmsi}`,
    // As with aircraft: the pieces, so the front end can write a sentence.
    properName: v.name || null,
    typeName,
    destination: v.destination || null,
    sublabel: [typeName, v.destination ? `→ ${v.destination}` : null].filter(Boolean).join(' · ') || null,
    klass,
    lat: v.lat,
    lon: v.lon,
    altM: 0, // at sea level by definition
    altSource: null,
    onGround: false,
    speedKt: v.speedKt ?? null,
    courseDeg: v.courseDeg ?? null,
    headingDeg: v.headingDeg ?? null,
    verticalRateFpm: null,
    sizeM: v.lengthM || VESSEL_SIZE_M[klass] || VESSEL_SIZE_M.unknown,
    ageS: v.lastPosition ? (Date.now() - v.lastPosition) / 1000 : null,
    extra: {
      mmsi: v.mmsi,
      callSign: v.callSign || null,
      imo: v.imo || null,
      typeCode: v.typeCode ?? null,
      lengthM: v.lengthM || null,
      // A vessel that has sent positions but no static data yet is a normal,
      // temporary state, not an error. The UI says so rather than hiding it.
      awaitingStatic: v.typeCode === undefined && !v.name,
    },
  };
}

// ---------------------------------------------------------------------------
// Demo mode: synthetic traffic, zero network
// ---------------------------------------------------------------------------

/**
 * Demo contacts go through the same normalise/merge shape as live ones, on
 * purpose, so that `--demo` cannot quietly drift away from the real code path.
 */

/** Metres along one leg of a demo track. Fine over the few km these cover. */
function demoLegM(from, to) {
  const dLat = (to[0] - from[0]) * 110574;
  const dLon = (to[1] - from[1]) * 111320 * Math.cos((from[0] * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * How long one cycle takes, DERIVED from the speed the entry claims.
 *
 * This matters more than it looks. The speed a demo contact reports has to be
 * the speed it actually moves at. When the two disagree, the front end's dead
 * reckoning extrapolates at one rate while the position advances at another,
 * and every poll yanks the marker back to the truth — a visible stutter that
 * looks like a rendering bug and is really a data bug. The hand-written periods
 * these replace were out by 2.8x to 6.9x for aircraft, and about 2x the other
 * way for vessels.
 *
 * A ping-pong track covers its leg twice per cycle, out and back.
 */
function demoPeriodMs(d) {
  const legs = d.pong ? 2 : 1;
  const speedKt = d.gs ?? d.speed;
  return ((demoLegM(d.from, d.to) * legs) / (speedKt * 0.514444)) * 1000;
}

/** Triangle wave in [0,1] with the given period, for back-and-forth tracks. */
function pingPong(periodMs, offset = 0) {
  const t = ((Date.now() / periodMs) + offset) % 1;
  return t < 0.5 ? t * 2 : 2 - t * 2;
}

/** Sawtooth in [0,1], for one-way transits that wrap around. */
function sweep(periodMs, offset = 0) {
  return (((Date.now() / periodMs) + offset) % 1 + 1) % 1;
}

const lerp = (a, b, t) => a + (b - a) * t;

/** Course over ground between two points, for synthetic tracks. */
function demoCourse(fromLat, fromLon, toLat, toLon) {
  const dLat = toLat - fromLat;
  const dLon = (toLon - fromLon) * Math.cos((fromLat * Math.PI) / 180);
  return ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
}

const DEMO_VESSELS = [
  {
    mmsi: '367123450', name: 'PORT IMPERIAL', typeCode: 60, lengthM: 42,
    destination: 'BROOKFIELD PLACE',
    from: [40.7290, -74.0332], to: [40.7148, -74.0142], offset: 0, pong: true, speed: 11,
  },
  {
    mmsi: '366998881', name: 'MISS GILL', typeCode: 52, lengthM: 28,
    from: [40.7900, -74.0175], to: [40.6720, -74.0380], offset: 0.2, pong: false, speed: 7,
  },
  {
    mmsi: '338111222', name: 'CIRCLE LINE XV', typeCode: 60, lengthM: 50,
    destination: 'PIER 83',
    from: [40.6950, -74.0250], to: [40.7720, -74.0060], offset: 0.55, pong: true, speed: 13,
  },
  {
    mmsi: '367445566', name: 'HUDSON SPIRIT', typeCode: 31, lengthM: 34,
    destination: 'ALBANY',
    from: [40.6800, -74.0330], to: [40.7850, -74.0120], offset: 0.35, pong: false, speed: 5,
  },
  {
    // Deliberately has no static data yet, to exercise the "position but no
    // name or type" path that real AIS puts you in for the first few minutes.
    mmsi: '367900123', name: null, typeCode: undefined, lengthM: null,
    from: [40.7205, -74.0295], to: [40.7350, -74.0210], offset: 0.8, pong: true, speed: 6,
  },
  {
    mmsi: '355778899', name: 'ATLANTIC TRADER', typeCode: 70, lengthM: 190,
    destination: 'PORT NEWARK',
    from: [40.6650, -74.0480], to: [40.6980, -74.0410], offset: 0.1, pong: true, speed: 9,
  },
];

function demoVessels() {
  return DEMO_VESSELS.map((d) => {
    const period = demoPeriodMs(d);
    const t = d.pong ? pingPong(period, d.offset) : sweep(period, d.offset);
    const lat = lerp(d.from[0], d.to[0], t);
    const lon = lerp(d.from[1], d.to[1], t);
    // Ping-pong tracks reverse course on the way back.
    const forward = d.pong ? (((Date.now() / period) + d.offset) % 1) < 0.5 : true;
    const course = forward
      ? demoCourse(d.from[0], d.from[1], d.to[0], d.to[1])
      : demoCourse(d.to[0], d.to[1], d.from[0], d.from[1]);

    return vesselToContact({
      mmsi: d.mmsi,
      name: d.name,
      typeCode: d.typeCode,
      lengthM: d.lengthM,
      destination: d.destination,
      lat,
      lon,
      courseDeg: course,
      // Half of the fleet reports no true heading, as in reality.
      headingDeg: Number(d.mmsi) % 2 === 0 ? course : null,
      speedKt: d.speed,
      lastPosition: Date.now(),
      lastSeen: Date.now(),
    });
  });
}

const DEMO_AIRCRAFT = [
  {
    hex: 'a1b2c3', flight: 'N76HL', r: 'N76HL', t: 'S76', desc: 'Sikorsky S-76',
    ownOp: 'Blade', category: 'A7', altFt: 1000, gs: 110,
    from: [40.7950, -74.0130], to: [40.6850, -74.0250], offset: 0.15,
  },
  {
    hex: 'a44f01', flight: 'UAL2231', r: 'N37298', t: 'B738', desc: 'Boeing 737-800',
    ownOp: 'United Airlines', category: 'A3', altFt: 4200, climbFpm: 2100, gs: 265,
    from: [40.6820, -74.1600], to: [40.8100, -73.9200], offset: 0.4,
  },
  {
    hex: 'ab9911', flight: 'JBU1442', r: 'N625JB', t: 'A320', desc: 'Airbus A320',
    ownOp: 'JetBlue', category: 'A3', altFt: 20500, gs: 420,
    from: [40.6400, -74.2200], to: [40.8600, -73.8300], offset: 0.7,
  },
  {
    hex: 'a77e20', flight: '', r: 'N4512G', t: 'C172', desc: 'Cessna 172',
    ownOp: null, category: 'A1', altFt: 1300, gs: 95,
    from: [40.6700, -74.0230], to: [40.8200, -74.0090], offset: 0.05,
  },
  {
    hex: 'a0c4d5', flight: 'N417AW', r: 'N417AW', t: 'EC35', desc: 'Airbus H135',
    ownOp: null, category: null, altFt: 900, gs: 105,
    from: [40.6900, -74.0210], to: [40.7800, -74.0160], offset: 0.6,
  },
  {
    // On the ground at Teterboro, with alt_baro as the literal string "ground".
    // This is the shape that turns into NaN if you do arithmetic on it, so demo
    // mode keeps one permanently in the feed.
    hex: 'a90210', flight: 'LXJ402', r: 'N402FX', t: 'CL35', desc: 'Bombardier Challenger 350',
    ownOp: 'Flexjet', category: 'A2', ground: true, gs: 12,
    from: [40.8500, -74.0610], to: [40.8600, -74.0480], offset: 0,
  },
];

function demoAircraft() {
  return DEMO_AIRCRAFT.map((d) => {
    const t = sweep(demoPeriodMs(d), d.offset);
    const lat = lerp(d.from[0], d.to[0], t);
    const lon = lerp(d.from[1], d.to[1], t);
    const track = demoCourse(d.from[0], d.from[1], d.to[0], d.to[1]);

    // Feed the normaliser raw readsb-shaped fields rather than a finished
    // contact, so demo mode exercises the same parsing and the same traps.
    return normaliseAircraft({
      hex: d.hex,
      flight: d.flight,
      r: d.r,
      t: d.t,
      desc: d.desc,
      ownOp: d.ownOp,
      category: d.category,
      lat,
      lon,
      alt_baro: d.ground ? 'ground' : Math.round(d.altFt + (d.climbFpm ? t * 3000 : 0)),
      alt_geom: d.ground ? 'ground' : Math.round(d.altFt + 75 + (d.climbFpm ? t * 3000 : 0)),
      gs: d.gs,
      track,
      baro_rate: d.climbFpm ?? 0,
      seen_pos: 1.2,
    });
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC_DIR, rel);
  // Refuse anything that escaped public/ despite the normalise above.
  if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/contacts') {
    const air = await fetchAircraft();
    const sea = currentVessels();
    sendJson(res, 200, {
      now: Date.now(),
      observer: OBSERVER,
      demo: DEMO,
      contacts: [...air.contacts, ...sea],
      sources: {
        air: {
          name: air.source,
          error: air.error,
          ageS: (Date.now() - air.at) / 1000,
          count: air.contacts.length,
        },
        sea: {
          status: aisState.status,
          error: aisState.error,
          messages: aisState.messages,
          count: sea.length,
        },
      },
    });
    return;
  }

  if (url.pathname === '/api/route') {
    const route = await lookupRoute(url.searchParams.get('callsign'));
    sendJson(res, 200, { route });
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, demo: DEMO, ais: aisState.status, vessels: vessels.size });
    return;
  }

  await serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Hudson Window on http://localhost:${PORT}${DEMO ? '  (demo mode, no network)' : ''}`);
  console.log(`Observer ${OBSERVER.lat.toFixed(4)}, ${OBSERVER.lon.toFixed(4)} at ${OBSERVER.eyeAltM} m MSL`);
  connectAis();
});

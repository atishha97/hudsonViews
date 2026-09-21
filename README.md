# Hudson Window

Identifies the ships, planes and helicopters passing my apartment window in
Newport, Jersey City.

The main view is an **illustrated field**: a figure standing on the grass, and
the shadows of aircraft crossing over him as they pass. A shadow enters from the
side the aircraft really is on, crosses the way it is really going, and is big
when it is close. Day, night and the direction shadows fall come from the actual
position of the sun.

The question it answers is **"what is that?"** — not "where do I look". It used
to do the latter, and that was wrong: if a plane is overhead you look up and see
it. Nobody needed telling which way to face, and nobody was going to search the
floor for it. Directions would only earn their place over data you *cannot*
simply look up and check — an archive of past traffic, say. The angles still
exist as figures in the details panel; they are a readout, not an instruction.

The screen has two layers, and this is the load-bearing design decision:

- **The card says what the aircraft IS, and nothing else.** The model, its
  registration and ICAO type, where the flight came from and where it is going,
  and one true thing about the type. That is the whole card.
- **It does not narrate what you can already see.** There used to be a bulleted
  description under the route — how far, how big, which way it was crossing, how
  high, how long it had left. It went the same way as the directions did, and
  for the same reason: you are looking at the aeroplane. Telling you it is
  crossing right to left is not information you lacked.
- **The numbers all still exist**, folded away under *Show all the details*.
  Nothing was deleted to make the front simple — it is a different view of the
  same solved geometry.

**Aircraft only, by default.** Boats are hidden behind a switch under *Set up
your window* (`showWater`, off). This is a display filter and nothing more: the
server keeps its AIS socket open and the vessel table keeps merging, so ticking
the box brings ships straight back with no reload and no code change. If you
want to stop paying for the socket as well, just don't set `AISSTREAM_KEY`.

```bash
node server.mjs --demo      # synthetic traffic, zero network
```

Then open <http://localhost:8808>.

For live data:

```bash
node server.mjs
```

Aircraft need no key at all, so with boats hidden (the default) that is the
whole setup. To bring ships back, set `AISSTREAM_KEY` and tick the box under
*Set up your window*. Without the key the vessel half is simply unavailable;
aircraft keep working regardless.

**Feed problems are no longer announced on the front.** The line that said
"Boats are not showing" lived in the footer strip, and the footer is gone. The
status pills under *Show all the details* still report every feed's state — that
is now the only place they are surfaced.

Node 22.4 or newer, for the global `WebSocket`. No dependencies, no build step,
no framework. Two files and one image.

---

## Why there is a server at all

Neither data source can be reached from a browser:

- **aisstream.io** explicitly forbids direct browser websocket connections.
- **The ADS-B aggregators send no CORS headers.**

Moving either call into the front end fails *silently* — you get an empty
vessel table or a request that never resolves, with nothing useful in the
console. Don't.

## Data sources

**Aircraft** — [adsb.lol](https://adsb.lol) first, with
[adsb.fi](https://adsb.fi) and [airplanes.live](https://airplanes.live) as
fallbacks. No API key. They are volunteer-run and rate limited to roughly one
request per second, so:

- The 4-second server-side cache is deliberate. Every browser poll inside that
  window collapses into one upstream call. **Do not remove it.**
- Sources are tried *sequentially* and the working one is remembered. Fanning
  out to all three in parallel is what gets you blocked.

Three things about these feeds that are easy to get wrong, and which the code
handles explicitly:

| | |
|---|---|
| **adsb.lol says `ac`, adsb.fi says `aircraft`** | Same per-aircraft fields, different name for the array that holds them. Reading only `ac` makes adsb.fi look like an empty sky. |
| **airplanes.live answers HTTP 200 with an `error` object** | It requires you to contact them and describe your project first. Until then it is not a working fallback, and an error body with a success status is not a success. |
| **A clean 200 with an empty list is not an empty sky** | It usually means a source has quietly stopped covering the area. An empty answer is never made the preferred source, or one bad response sticks forever. |

**Ships** — one long-lived aisstream.io websocket held by the server, merged
into a vessel table keyed by MMSI, with reconnect and backoff.

**Routes** — [adsbdb.com](https://api.adsbdb.com), keyless, ~100 ms. ADS-B
carries no route at all; it is a position and an identity and nothing else. This
maps a callsign to its filed origin and destination.

It is a small community service, so the lookup is deliberately frugal: only the
four aircraft actually named on screen are ever asked about, answers are cached
for six hours, and *misses are cached too* — for an hour — because otherwise
every private flight would be re-asked every few seconds forever. A page sitting
open for an hour makes a few dozen requests, not thousands.

**General aviation has no filed route to find.** A Cessna pottering up the
Hudson comes back unknown every time, and so do some charter flights. That is
the honest answer rather than a failure, and the card says so in words.

## Geometry

All of it lives in `public/index.html`. It is the interesting part.

**Bearing** is a proper great-circle forward azimuth. The flat
`atan2(Δlon, Δlat)` shortcut is wrong by **7.9°** on a northeast leg at this
latitude — enough to put a ship outside the window.

**Elevation** is `atan2(Δh − curvature drop, ground distance)`, with the drop
computed against an effective Earth radius inflated for standard atmospheric
refraction (k ≈ 0.13). It matters past about 10 km: a vessel at 20 km sits
0.19° below eye level rather than the 0.115° flat geometry predicts.

Both altitudes must be on the **same datum**. The observer's eye height is
stored as height above *mean sea level*, not above the street, because aircraft
altitudes are above sea level too.

**Projection** is a real pinhole camera — yaw to the window facing, pitch,
divide by depth — with one focal length for both axes, so pixels stay square
and the vertical field of view falls out of the pane's aspect ratio instead of
being invented. A linear bearing→x mapping would be **43 px off** at 25°
off-axis on an 800 px pane. It is a window and not a chart, so it should agree
with the glass.

Consequences worth knowing:

- The pane is kept landscape at every width. A portrait pane would imply a
  vertical field of view over 120°, which a flat rectilinear rendering
  stretches grotesquely.
- Range rings and elevation arcs are drawn as sampled polylines, because they
  are **not straight**. A set of directions at constant elevation is a cone, and
  a cone projects to a conic section. Only the true horizon is genuinely
  straight, being the one case that is a plane through the camera centre.
- Markers are placed by true angular size and **never move to avoid overlap**,
  because a marker that has been nudged is no longer telling the truth about
  where the aircraft is. Only labels dodge, with a leader line back.

**Screen heading** is found by projecting where a contact will be twelve
seconds from now and taking the screen-space difference — not by rotating its
true course into the frame. An aircraft flying directly away has a course equal
to the window facing, but on screen it crawls toward the vanishing point rather
than pointing "up". Perspective applies to velocity as well as position.

Positions are dead-reckoned between fetches from reported course, speed and
vertical rate, capped at 20 s so the extrapolation never becomes a lie.

**Extrapolation is anchored to when the position was true, not when the bytes
arrived.** These are not the same instant: the aircraft cache is deliberately
4 s and the browser polls every 3 s, so a response regularly carries a position
that has not moved since the last one. Resetting the clock on arrival treats
that stale position as current and discards the motion already drawn, which
shows on screen as the marker snapping backwards once per poll. `dataAgeS`
carries the server's reported cache age into the extrapolation. Vessels are read
live from the in-memory table and carry no transport age, so they get none.

## Plain language

The whole front end of the app is one thing: turning solved geometry into the
sentence you would say to someone next to you. Three rules do most of the work.

**"In the window" means both axes.** It is tested against the real projection,
not against a bearing. An aircraft passing almost overhead at 3 km is close,
huge, and completely invisible from a chair by the glass. Naming something you
cannot see from where you are sitting is worse than saying nothing — that is
about what is *visible*, which still matters even though the app no longer tells
you which way to turn.

**Nothing beyond the view radius is mentioned at all.** `viewRadiusKm`,
default **5 km**, adjustable under *Set up your window*. Past it, an aircraft is
scenery: not named, listed, counted or drawn. This is a harder cut than the
apparent-size bar and sits in front of it — within a few kilometres the size bar
is almost always satisfied anyway, so in practice the radius is what decides.

The field's depth follows it, so the ground always spreads the range actually on
show across the full frame instead of squeezing it into the bottom.

Measured from Newport over a couple of minutes of real traffic, this is what the
radius buys you:

| within | something in the 85° window |
|---|---|
| 3 km | 13% of the time |
| 5 km | 13–20% |
| 8 km | up to 100% facing north-east |
| 12 km | 100% in most directions |

Radius alone (ignoring the window arc) something is within 5 km about half the
time, and the median nearest aircraft is 5.1 km. Sweeping all eight compass
facings, **5 km is sparse in every direction** — the best case is 20%, facing
east or north-east. Eight kilometres is where north-east becomes reliable.

So the default means an empty screen much of the time, which for "only tell me
about things genuinely close overhead" is the correct answer rather than a bug.
It is a slider precisely because that is a matter of taste, and the honest
numbers above are the ones to argue with.

**Things too small to find are not mentioned.** The bar is `WORTH_A_LOOK_DEG`,
and it is set against eyesight rather than against tidiness. The eye resolves
about one arcminute (0.017°), so the cut sits at roughly five times that — an
airliner inside 25 km, a helicopter inside 10. Those really are visible: a jet
on approach at 12 km is a third the width of the full moon and perfectly plain
against a clear sky. Anything under the bar is still *drawn* in the window,
because the sky does look like that, but is not named, listed or counted. When
nothing clears it, see the rule below.

Clutter is then handled by ranking and capping, which is the honest way round.
An earlier version set the bar five times higher to keep the list short, and
that was wrong twice over — it called plainly visible aircraft invisible, and
with boats hidden it left the app reading "nothing much to see" while sixty
aircraft were overhead. The supporting list is capped at three, because
flights-only over this window means most of what is up there is ten to thirty
kilometres off, and a longer list is half a dozen cards that all say "a distant
speck".

**The card makes one claim, never two.** It used to say "nothing much to see"
and then, in the very next sentence, name a helicopter two kilometres past the
radius. Those cannot both be true. So:

- Something inside the radius → the card names it.
- Nothing inside the radius, but something genuinely visible from this window →
  the card names *that*, and the distance does the rest of the work. "About
  6.2 km away, a distant speck" is honest without needing a disclaimer.
- Nothing visible at all → "Nothing in your window", and nothing else.

The tally in the header counts the same set the card is drawn from — what is
visible from this window — rather than what is inside the radius. Counting the
radius there was what let the header read "nothing to see" while the card named
an aircraft directly beneath it.

The radius still governs the supporting cards, the shadows on the field, and the
counts. It does not get to veto naming the one aircraft that is actually up
there.

**One thing at a time.** The card picks whatever is largest in the window,
because apparent size is what "you would notice it" actually means — a ferry
300 m out is a bigger thing in the glass than an airliner 8 km up. It holds
that choice unless something becomes clearly more noticeable, so the card does
not flip between two similar contacts every few seconds while it is being read.
Tapping anything overrides the choice.

One phrasing still earns its place: `article()` — "An American jet", but "a
United jet", because the U in these names is a Y sound and the plain
`/^[aeiou]/` test gets it wrong.

There was a set of describers here — `distanceWords`, `sizeWords`,
`motionWords`, `heightWords`, `timeWords` — that turned the geometry into
"about 6.9 km away, a small dot, crossing right to left, moving away". They have
been deleted rather than left unreachable. The same quantities are still in the
details panel as figures, via `fmtDistance`, `fmtHeight` and `fmtMoving`.

`apparentDeg` survives them: it is what `WORTH_A_LOOK_DEG` tests, and what ranks
the field and the card order. The threshold still decides what gets named; there
is simply no longer a sentence describing the result.

## What the screen carries

Deliberately little. The card names the aircraft, its registration and type, the
route, and one fact. Below it, up to three more cards. Then the two disclosure
panels. That is the whole surface.

Removed along the way, each because it was telling you something you either
already knew or had not asked for: the directions ("look a little to your
left"), the bulleted description of distance, size, motion, height and time, the
title bar with its contact count and theme switch, and the footer strip — the
"N in the sky nearby" line, the captions painted on the artwork, and the
technical notes at the foot of the details panel.

Everything factual those carried still exists under *Show all the details*: the
full table with distance, height and motion as figures, the calibrated window
view, and the feed status pills.

## The painted background

The field is `dayView.png` / `nightView.png`, measured rather than eyeballed:

- The artwork is **6504 × 4204** with a **974 px corner radius**, and that corner
  is a true circle (the 45° inset measures 294 px against 285 predicted — within
  antialiasing).
- A percentage `border-radius` is resolved **per axis**, so a circular corner on
  this aspect is `14.98% / 23.17%`. That is why the two numbers differ, and why
  the aspect is locked: let it stretch and the corners stop being circles.
- The corners are **transparent in the source**, so whatever sits behind the
  artwork is just the page. White.

The originals are 25 MB each, which is not a background. They are flattened onto
white and downscaled to 2400 px wide as `dayView-bg.jpg` / `nightView-bg.jpg` —
**387 KB**, a 98% saving. Flattening onto white rather than keeping the alpha
means that if the CSS radius and the artwork's radius ever disagree by a pixel,
the fringe is white on a white page instead of a dark halo.

Both paintings are shown **exactly as painted — no filters**. There was briefly
a CSS filter faking night out of the day image, back when `nightView.png` was a
byte-for-byte copy of `dayView.png`; it is gone.

Two details that matter:

- **Which painting loads is decided by the phase, and the base rule carries no
  image at all.** If the day painting were the default, every load would fetch
  it and show it for a frame before swapping — a visible flash of daylight at
  midnight, and a wasted 387 KB. `renderScene()` therefore runs once at boot,
  before the first paint, so only the correct painting is ever requested. One
  network request, verified.
- **The CSS radius clips a hair inside the artwork's own** (15.15% / 23.43%
  against the painted 14.98% / 23.17%, both files sharing the same 974 px
  corner). The paintings are flattened onto a background colour when they are
  downscaled, and clipping inside guarantees that colour can never show as a
  fringe, whichever page colour sits behind.

**The aspect lock is gone entirely, and the margin is even on all four sides.**
Those two are mutually exclusive: a card locked to the artwork's proportions and
centred gives whichever axis does not bind all the slack. On a 16:10 screen that
was 18 px at the sides against 21 px top and bottom and barely showed; at
800×949 it was 18 px against **241 px**. The card is now inset by the same gap
everywhere and the painting covers it, cropping to whatever shape the window is
— so the margin is equal by construction at any size rather than by coincidence
at one. Verified at 1440×900, 825×979 and 375×812: 18 px on every side.

On a phone the card stays a banner across the top with the panel below it,
inset by the same 18 px.

`favBoy.png` is in `public/` but unused — you asked for the two view images only
for now.

## Type

**Basis Grotesque Pro**, five static cuts in `public/fonts/`, declared at the top
of the stylesheet and reached only through the `--sans` token so nothing
downstream names a family directly.

Two things needed deciding rather than copying:

- **The weights are declared as ranges, not points.** The stylesheet asks for
  560, 580, 600, 640 and 650 — numbers picked when this was running on a
  variable system font. CSS weight matching for any target above 500 searches
  *upwards* first, so every one of those would have resolved to Bold and the
  Medium cut would never have been used at all. Medium is declared `451 600` and
  Bold `601 800` instead, which puts the split where the design does: card
  titles and labels take Medium, the aircraft name and the eyebrow above it take
  Bold.
- **The files are the Arabic Pro cuts**, which sounds like it should be a problem
  for a page with no Arabic in it. It is not: their cmap carries the full Latin
  set, checked rather than assumed, including the `→` and `·` this page sets in
  routes and idents. Had either been missing the browser would have substituted
  silently for those characters alone, which is the kind of thing you notice six
  months later.

Only the three weights actually used are fetched. Light and Black are declared
for completeness and cost nothing until something asks for them. The monospace
token is untouched — registrations and callsigns want tabular figures.

## The panels

Liquid glass. Four things together make a panel read as a lens rather than a
translucent grey rectangle, and it needs all four: a backdrop that is brightened
and saturated as well as blurred, a fill that is a gradient rather than a flat
wash, light bouncing in off both the top and bottom inner edges, and a specular
rim that is brightest at two opposite corners rather than glowing evenly all the
way round. The shadow is three layers — one tight contact shadow that pins the
panel to the field, two wide ambient ones. A single large blur reads as a
sticker.

**Nothing drawn on a panel can use an opaque colour.** The divider above the
fact used `--line-2`, a fixed near-white grey, which is fine on an opaque card
and wrong on a see-through one: the panel's own lightness changes with whatever
is behind it, so the same rule read clearly where grass showed through and
faded out where sky did. It is `--rule-glass` now, translucent ink, which
darkens whatever it sits on by a constant fraction instead of painting a fixed
value. Measured across the rule's length, the old one varied by 19% end to end
and the new one by 3%, at roughly twice the strength. The same fix applies to
the two panel dividers inside the details and calibration bodies.

The rim is a gradient-filled ring: a pseudo-element the size of the panel, filled
with the gradient, then masked down to its own 1px border by subtracting its
content box from itself.

**The saturation is a legibility setting, not a taste one.** At `saturate(200%)`
over a green meadow the panels turn green, and the faint 11px ident text drops to
2.4:1 against what is behind it. Measured properly — the backdrop filter replayed
on a canvas, the fill composited over it, WCAG contrast computed against the
actual ink colour — rather than eyeballed, because a glass panel's effective
background is not any colour that appears in the stylesheet. `saturate(170%)` at
0.72 fill holds every other text layer at 5:1 or better.

**`.ident` is the exception, at about 2.5:1, and it was already there** — the
same measurement against the old frosted panels gives 2.53–2.58, so the glass did
not cause it. It is `--ink-3` at 11px: a token deliberately chosen to recede.
Worth knowing it fails AA if that text ever needs to be read rather than glanced
at.

## Voice

The copy went through a pass late on, and three things drove it.

**The section labels were dashboard furniture.** "Right now", "Also out there",
"Did you know" were headings doing a job the layout already did: there is one
big card and a short list under it, and nobody needs a label to work out that
the small ones are also aircraft. The whole point of the rewrite that produced
this layout was that it should stop looking like an instrument panel, and those
three were the last of it. The featured card now says what the thing actually is
("Overhead", or "On the water"), and "Did you know" became "Worth knowing",
because "did you know" is the most tired phrase in interface writing and the
facts underneath it are good enough not to need it.

**The empty sky was the least-considered sentence in the app and by far the
most-read.** Sampling this window put something inside five kilometres about
half the time and inside three about one time in eight, so "Nothing in your
window" was what the screen said most of the time anyone looked at it. It
rotates now, keyed to the minute rather than to the poll, or it would reshuffle
every few seconds while you were still reading it.

**The copy described the app's problems rather than the sky.** "No published
route" is a statement about a missing database record. What it actually means is
more interesting than a scheduled airliner would be: someone flying for
themselves rather than to a timetable, which is a traffic helicopter or a flight
school or a person who owns a plane. The line says that instead.

The register to match, and the best sentence in the app before any of this, was
already sitting in the calibration panel: *anything further than five kilometres
is treated as scenery*. Precise, unfussy, and it tells you how to think about
what you are looking at.

## The disclosure marker

The two panels at the bottom of the rail open with `Plus.png` rather than the
browser's native triangle, turned 45 degrees into a close cross when the panel is
open. One asset covers both states, and the turn itself tells you the click
landed.

It is drawn as a CSS **mask**, not an `<img>`. The artwork supplies the shape and
`currentColor` supplies the colour, which matters twice over: the file is black,
so as an image it would have needed inverting by hand for the dark theme, and it
would have sat inert while the summary around it changed colour on hover. Masked,
it follows the theme and the hover state for nothing.

## The field

The main view is an illustrated ground plane with a figure standing on it, and
aircraft passing overhead as shadows. It is not decoration — it carries the same
solved geometry as everything else:

| | |
|---|---|
| **x** | where the aircraft is left-to-right across your field of view |
| **y** | how far away, on a log scale, near at the bottom |
| **size** | that same distance, times the aircraft's real size |
| **heading** | the projected direction it will have moved in fifteen seconds |

So a shadow enters from the side the aircraft really is on, crosses the way it
is really travelling, and is big when it is close. Up to three at once, matching
the cards; where two cross, the ground gets darker, because that is what
shadows do.

Distance is mapped logarithmically between 800 m and 35 km. A linear map put
everything past 6 km in the top tenth of the frame, which is where the traffic
actually is.

The field is inset on the left by the width of the glass panel, so an aircraft
off to your left is drawn where you can see it rather than behind the UI.

### Day and night come from the sun, not the theme

`solarPosition()` computes the real elevation and azimuth of the sun for your
latitude and longitude. That decides two things:

- **Which of four looks the field wears** — day, golden hour, dusk, night.
- **Which way shadows fall, and how long they are.** Shadows point away from the
  true solar azimuth and stretch by `1/tan(elevation)`, so at six in the evening
  the figure throws a long shadow across the grass and at midday barely any.

The maths is the low-precision NOAA method, worth checking because it is easy to
get subtly wrong: at this latitude it returns 72.7° at the summer solstice and
25.8° at the winter one, which is exactly 90 − 40.73 ± 23.44.

The palette for all four phases lives in CSS custom properties on
`.scene[data-phase]`, not as literals in the script — same rule as the rest of
the file. The script sets the attribute and reads back the two values an SVG
fill cannot take as a variable.

### The shadows

`airplaneShadow.png` and `helicopterShadow.png`, painted to match the field, at
720 px wide and about 220 KB each. They replaced a set of SVG silhouettes drawn
in code, and the aircraft's `plainKind` still picks between them.

Two things had to be measured rather than guessed:

- **Each PNG is pre-rotated**, so pointing one along a flight path means
  correcting for the heading it was painted at. Taken from the principal axis of
  the alpha channel: the jet's fuselage runs **13° above** horizontal with the
  nose right, the helicopter's **27.5° below** it. Verified by drawing both at
  0°, 90°, 180° and 270° and checking the nose landed where it should.
- **The painted shape does not fill its file** — 83% of the width for the jet,
  90% for the helicopter, from the alpha bounding box. The image is scaled by the
  reciprocal so the requested span is the aircraft, not the canvas around it.
- **They are mirrored, not rotated, past 90°.** Neither is a flat plan view: the
  helicopter's landing skids hang below its cabin, so the art has a definite
  "down" side, and simply rotating it put the skids on top — the machine read as
  upside down. Past 90° the silhouette is mirrored across its own nose-tail axis
  instead: `rotate(heading) scale(1,-1) rotate(-intrinsic)` leaves anything on
  the nose axis where it was, being the mirror line, and swaps everything either
  side. An aircraft is near enough symmetric for the result to be
  indistinguishable. Checked at −60°, 20°, 120° and 200°; the skids stay
  underneath in all four.

**A shadow softens with height.** A cast shadow is only sharp when whatever
throws it is close to the ground; a jet at nine kilometres throws nothing you
could call an edge. Each shadow is blurred by `0.6 + 3.2 px per km` of altitude
and faded by 22% per kilometre, so a helicopter at 300 m lands crisp and dark
while an airliner overhead is a soft grey smudge — which is both what the sky
actually does and a free depth cue for how high the thing is.

Both are bounded. The blur is capped at 6% of the drawn span, or a distant
aircraft dissolves entirely rather than reading as high; the fade floors at 0.45,
or the highest traffic would vanish against the grass.

**They are drawn at every hour, night included.** That is a deliberate conceit,
not physics: there is no sun at midnight to cast one. It was asked for, and it
reads far better than the glowing dots it replaced.

Opacity climbs as the light falls — 0.62 by day up to **0.82** at night — because
visibility is opacity times how much darker the shadow makes the ground, and on a
dark meadow even black adds little absolute difference. At the daytime value the
night shadows were nearly invisible.

The originals are still in the project root at full size; `public/` holds the
downscaled copies the page actually loads.

## The figure

`public/favBoy2-sprite.png`, derived from the `favBoy2.png` upload: trimmed to
its alpha bounding box and scaled to 560 px tall, which takes 2766 KB down to
**180 KB**.

He is painted in watercolour, so for the first time the figure and the ground he
stands on are the same medium. The two figures before him were flat vector
against a painted field.

The trim is small here — 39 px of padding on the left, 9 px below — but it still
matters: the cast shadow anchors to the sprite's bottom edge, so any padding
under his feet would float him above his own shadow.

His proportions are **0.367**, against 0.338 for the previous figure and 0.352
for the one before that, near enough that none of the sizing needed retuning. He
arrived with real transparency, so no cutout was necessary.

He does not carry a drawn drop shadow, and should not: his is cast fresh each
frame from the sun's position, so it agrees with the aircraft shadows instead of
contradicting them.

**That shadow is his own silhouette, sheared onto the ground.** It was an
ellipse first, which is not what a standing person casts and looked exactly like
the placeholder it was. The sprite is now drawn a second time through a matrix
that pins his feet and sends his head off along the light:

```
(x,  0) -> (x, 0)          the feet stay put
(0, -h) -> (dx·L, dy·L)    the head lands at the end of the shadow
```

which is `matrix(1, 0, -dx·L/h, -dy·L/h, figX, figY)`. Length is `h/tan(e)` —
his height times `stretch` — with a foreshortening factor for seeing that ground
obliquely, capped so a low sun cannot throw it off the field. A `brightness(0)`
filter keeps the alpha and discards the colour, so what lands on the grass is
his outline rather than a flattened copy of him. It carries the same opacity as
an aircraft shadow, because it is the same sun on the same grass.

**He is centred on the card and 18% of its height.** Both the sprite and the
shadow are placed from one pair of numbers — the sprite through CSS custom
properties, the shadow directly — so they cannot drift apart. His feet sit half
his height below centre, so that his middle rather than his soles lands on the
centre line. The cast shadow scales from his height, not the card's: it used to
be a fraction of the card, so shrinking him left the shadow full size and
visibly detached.

The upload is untouched at `public/favBoy.png`.

**Unused files**, none of them referenced any more:

| | |
|---|---|
| `flight.png` | 21 MB — the original illustration |
| `figure.png` | the figure cut out of it |
| `favBoy.png` + `favBoy-sprite.png` | the line-art figure |
| `dayView.png`, `nightView.png` | 24 MB each — sources for the backgrounds |
| `favBoy2.png` | 2.7 MB — source for the current figure |

The `.png` sources are worth keeping if the derived assets ever need
regenerating at a different size; `flight.png`, `figure.png` and the favBoy pair
are not. Delete whenever you like.

That first cutout was the awkward one, for the record: a colour key left a
quarter of the crop as speckle, and a tighter threshold ate the skin, which sat
only ~65 RGB units from the background green. What worked was that the palette
contained no green at all, so `g > r + 8 && g > b + 8` separated them exactly.

## Concentric corners

    outer radius = inner radius + gap

The cards are the fixed term. They keep a conventional **20 px** corner and
ordinary padding; the painting bends to fit them at **44 px**, with a **24 px**
gap. Verified in the browser rather than eyeballed: `20 + 24 = 44`, and the
insets on both axes are equal, which is what actually puts the two corner arcs
on the same centre.

**It was the wrong way round first, and that is worth recording.** With the
painting's corner as the fixed term the arithmetic ran backwards: the artwork's
corner is 0.1515 of the card width — 203 px at 1440×900 — so a 24 px gap forced
a 179 px card corner. A disclosure panel is 39 px tall. A 39 px-tall box with a
179 px radius is a pill. Every panel became a lozenge, and no amount of adjusting
padding was going to rescue it, because the radius was the problem.

**So the artwork was cropped.** It carried a 974 px corner of its own, which a
44 px frame would have exposed as a flat arc in each corner. The source is cut
300 px in on every side — past `r · (1 − 1/√2) = 286 px`, the inset at which a
square corner is guaranteed to land inside the painted area. The corners are
paint now, so the frame's shape belongs entirely to the stylesheet. Aspect
becomes 5904 × 3604.

Two smaller things that had to be fixed for any of it to hold:

- **Spacing had three authorities.** `.now` carried `margin-top: 14px`, and the
  disclosure panels 20 px and 12 px, producing a 52/14/35/26 rhythm and a top
  inset of 197 px against a left inset of 183 px — which is why the top-left
  looked wrong even when the radii were right. The flex `gap` is the only
  authority now, at 14 px.
- **Specificity.** `.rail > *` loses to `details.tech`, so the first attempt at
  clearing those margins did nothing. The selectors match the element too.

## Layout

The field fills the window. Everything readable sits in a rail down the left in
frosted panels: *Right now*, then the supporting cards, then *Show all the
details* and *Set up your window* as progressive disclosure.

The calibrated window view — true bearings, range rings, elevation arcs, the
pinhole projection — now lives inside *Show all the details*, along with the
full table and the feed diagnostics. Nothing was lost.

Four things that bit while building this:

- **The theme follows the painting, not the operating system.** They can
  disagree, and when they did the result was unreadable: a light theme at ten at
  night put dark ink on a dark field and the header vanished. `data-theme` is now
  set from the scene's own phase — light for day and golden hour, dark for dusk
  and night — so every control resolves against the picture actually behind it.
  The panels are glass; whatever is painted under them decides what is legible on
  them, and the OS has no opinion worth having about that.

- **`.field` meant two different things.** The class was on both the scene's
  painting layer and each row of the calibration form, so
  `.field { background-image: url(dayView-bg.jpg); background-size: cover }`
  painted a full-bleed meadow behind all nine form rows — green labels on green
  grass, the form effectively unusable. The painting layer is `.painting` now.
  Worth noting how it hid: both classes are plausible names in their own context,
  nothing errored, and the form only looks wrong once you open a panel that is
  collapsed by default.

- A CSS `fill` property outranks an SVG presentation attribute, so a rule like
  `.figure-shadow { fill: var(--shade) }` silently overrode the colour the
  script set per frame. Fill and opacity are set from the script; there is no
  CSS fill.
- `inWindow()` used to measure the live pane to derive its vertical field of
  view. With the instrument now inside a collapsed panel that measures zero, it
  is a fixed 16:7 frame instead — otherwise folding the panel away would quietly
  change which aircraft counted as visible.

## The horizon pane

Inside *Show me the numbers*. Four things were making it look homemade.

**Every label carried a halo.** A 2.5 to 3px stroke of the page colour behind
small text is how you force legibility over a busy background, and the sky here
is a smooth gradient, so it was buying nothing and costing the letterforms their
shape. The frame labels are tracked-out caps in muted ink now, with no stroke at
all. Marker tags keep a halo, at 2px and 55% opacity, because those genuinely do
sit on varied ground and move around.

**The horizon was a drawn line.** A real one is not: it is where haze stacks up
until the sea stops being distinguishable from the sky. The line is now barely
there at 0.28 opacity, and a soft band centred on it does the work.

**Half the pane was water that can never hold anything.** Pitch was -5, tilted
down, with a comment saying it was so the water got more of the pane. That was
right when this drew ships. With vessels hidden it meant half the instrument was
dead space while every aircraft crowded into the top. Pitch is +7 now, which puts
the sky at about two thirds at the default field of view.

This is safe to change precisely because of what the calibration measurements
found: pitch does not affect which aircraft count as on screen, so moving it
changes the framing and nothing else. Verified again here, the count held at 2
across the whole range from -5 to +20.

**The grid was noise.** Finer dashes, lower opacity. Worth recording that the
first pass overshot and made the arcs invisible, which is not the same as quiet;
they are back at 0.2.

## Calibration

Three settings, cut down from seven. Which ones survived was decided by
measurement, not taste: each was swept across its full slider range and the
aircraft actually reaching the screen were counted.

| Setting | Swept | Aircraft on screen |
|---|---|---|
| Which way the window faces | 0 to 315 degrees | 5, 4, 0 |
| How wide the view is | 30 to 150 degrees | 0, 1, 4 |
| How far out to look | 2 to 14 km | 1, 3, 4 |
| Looking up or down | -15 to +30 degrees | 4, 4, 4, 4, 4 |
| How high your window is | 0 to 300 m | 4, 4, 4, 4, 4 |

**Pitch changed nothing across three quarters of its range**, and only moved the
count at the extreme -30 end. **Eye height changed nothing at all**, from ground
level to three hundred metres. Neither is a bug. Both were load-bearing when this
drew the water: eye height sets the horizon dip, which decides when a ship
disappears over the curve, and pitch decided how much pane went to sea rather
than sky. With vessels hidden they had nothing left to do, because aircraft are
too high and too close for three hundred metres of eye height to matter.

Both still exist in the view model at their defaults and the projection still
reads them. Only the controls are gone, so there is no behaviour change, just
two fewer numbers to be confused by.

**Latitude and longitude are shown, not edited.** They are not a preference, they
are an address, and the panel already said so in its own hint: "You shouldn't
need to touch these." The server is the real authority through `HW_LAT` and
`HW_LON`, and the line warns when the two have drifted apart.

**The note box used to say to calibrate against a boat.** Boats are no longer
drawn, so the only calibration instruction in the app pointed at something that
does not appear. It now says to wait for a helicopter or a low aircraft and line
its shadow up with where you are actually looking.



The panel in the UI writes to `localStorage`. Server-side query origin is set
with `HW_LAT` / `HW_LON`; the UI warns if the two have drifted apart.

**Facing is a true bearing.** AIS and ADS-B both report true bearings, but a
phone compass reads magnetic, and declination here is about **13° west**. A
facing measured on a phone and typed in raw is 13° wrong — about a ship's width
in the pane. The calibration panel has a checkbox that applies the correction.

The fastest way to get the facing right is to wait for a helicopter or a low
aircraft you can actually see out the window, then nudge the facing until its
shadow crosses where you are looking. This used to say to use a ferry, which
stopped working the day vessels were hidden.

## Identity, routes and facts

The card leads with the **model** — "Boeing 737-900", not "a passenger jet" —
then the technical line (`Delta 2323 · N846DN · B739`), then the route
(`Boston BOS → Jacksonville JAX`), then one fact about the type.

Model names come from the local `TYPE_NAMES` table **in preference to the feed's
own `desc`**. adsb.fi supplies one, but shouting: "BOEING 737-800", "PIPER
PA-28R-180/200/201". Where the table has no entry the feed's version is tidied —
title-case the all-caps words, leave anything containing a digit and anything
three characters or shorter alone, so model codes and MAX and XLS survive.

`FACT_GROUPS` holds one checkable claim per type family — 52 groups covering 121
type designators, which came out at **96% of live traffic** when measured. They
are grouped by family because a fact about the 737 is a fact about all of them.
Everything in there is a well-established claim; no folklore, and nothing that
needed a qualifier to be true.

The uncovered 4% are aircraft broadcasting no type designator at all. Nothing to
be done about those, and the card simply omits the line.

## Identification

**Helicopters come from the ADS-B `category` field (`A7` = rotorcraft)**, not
from string-matching the type designator or the operator name. Category is the
only signal in the feed that is actually reliable. A small table of rotorcraft
type designators backs it up for aircraft transmitting no category — which is
common, and is the case for a good share of the corridor traffic.

The other categories are **weight bands, not roles**, and the class names say
so. A3 is 75,000–300,000 lb, which is most airliners but also a Gulfstream V.

For the plain view the server also derives a `plainKind` — helicopter, small
plane, private jet, passenger jet, cargo plane — and the order the rules fire
in matters:

- **Flying for a scheduled airline settles it before weight does.** A CRJ700 is
  category A2, but "a GoJet small jet" is not what anyone would say about a
  regional airliner full of passengers.
- **Business jets are checked by type designator**, because weight cannot tell
  them apart from airliners and Teterboro is close enough that a good share of
  what crosses this window is one.
- **`ownOp` is never used for the plain name.** It is the *registered owner*,
  very often a leasing trust: adsb.fi reports American Airlines flight AAL1942
  as owned by "U S BANK NA TRUSTEE". The airline table, keyed off the callsign
  prefix, is both more accurate and more readable. `ownOp` still reaches the
  detail view.

adsb.lol serves neither `desc` nor `ownOp`, so `server.mjs` carries small static
tables mapping ICAO type designators to aircraft names and ICAO airline
designators to operators. Without them the primary source can only ever say
"B38M". adsb.fi *does* fill both fields in, so a fallback fetch identifies
aircraft slightly better than the primary.

Ship type comes from the AIS type code, which is decade-encoded — 60s
passenger, 70s cargo, 80s tanker — with the individually meaningful sub-codes
in 30–59 handled separately (52 tug, 31/32 towing, 36 sailing, 37 pleasure).

### AIS traps the merge has to handle

- **Names arrive on a different message than positions.** Position reports
  (types 1/2/3/18) carry no name and no ship type. `ShipStaticData` (types
  5/24) carries those, and arrives about every six minutes. The table merges
  per field; a wholesale replace on each position report wipes the static half
  within seconds of receiving it. A vessel that is visible and nameless is a
  normal temporary state, and the UI labels it *awaiting name* rather than
  hiding it.
- **`TrueHeading` is 511 when unavailable**, which is most of the time for
  smaller craft. Drawing an arrow from it points the whole fleet the same
  absurd direction. Course over ground is used for motion; 511 and COG 360 and
  SOG 102.3 are all treated as "not available".

### Aircraft traps

- **`alt_baro` is the string `"ground"`** for surface traffic in every
  readsb-derived feed. Arithmetic on it yields `NaN` and the contact silently
  vanishes or lands somewhere nonsensical. Demo mode keeps one grounded
  aircraft in the feed permanently so this path stays exercised.
- **More than half the feed is on the ground.** There are four major airports
  within 30 nm. On a normal afternoon roughly 70 of 140 returned aircraft are
  parked or taxiing, none of it visible from Newport, and all of it would
  otherwise be drawn floating on the water at the horizon. It is filtered out
  of the view and counted in the status bar instead.
- **Prefer `alt_geom` over `alt_baro`.** Barometric altitude is referenced to
  29.92 inHg, not sea level, and on a low-pressure day is worth several hundred
  feet — which matters a great deal for the corridor helicopter traffic at
  1,000 ft. Where only a barometric value exists the UI tags it `baro`.
- **Sea-level contacts past the visible horizon** (24 km from 40 m up) are
  hidden by the curve of the Earth. They stay in the list, greyed and labelled,
  but are not drawn in the pane.

## Constraints

- No npm dependencies, no build step, no framework. One HTML file, one server
  file.
- `node server.mjs --demo` must keep working with synthetic traffic and zero
  network. Demo contacts are fed through the same parsing and merging code as
  live ones, so demo mode cannot quietly drift from the real path.
- **A demo contact's cycle time is derived from the speed it reports**, never
  written by hand. The two used to be independent numbers, and they disagreed by
  2.8x to 6.9x for aircraft and about 2x the other way for vessels. That is not
  cosmetic: the front end extrapolates at the reported speed, so when it does
  not match the real motion, every poll yanks the marker back to the truth and
  the display visibly stutters. It looked like a rendering bug and was a data
  bug. Measured against live ADS-B, reported and actual speed agree to 0.99x
  across 48 real aircraft — demo now agrees to within 3%.
- Both light and dark themes stay correct. Colours come from the CSS custom
  properties at the top of `index.html`, never hardcoded.
- **Air is always the orange token, water is always the teal token.** That
  mapping is load-bearing for reading the screen at a glance.

## Environment

| | | |
|---|---|---|
| `AISSTREAM_KEY` | — | aisstream.io key. Vessels are unavailable without it. |
| `PORT` | `8808` | |
| `HW_LAT` / `HW_LON` | `40.7267` / `-74.0345` | Query origin. Match the UI's observer. |
| `HW_EYE_ALT_M` | `40` | Eye height above **sea level**. |
| `HW_AIR_RADIUS_NM` | `30` | Aircraft fetch radius. |
| `HW_SEA_RADIUS_KM` | `14` | AIS bounding box. Bigger is a firehose you cannot see. |
| `HW_CACHE_MS` | `4000` | Aircraft cache. Leave it alone. |
| `HW_VESSEL_TTL_MS` | `720000` | Drop a vessel after this long without a position. |

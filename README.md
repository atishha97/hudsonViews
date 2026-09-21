# Hudson Window

My partner is an aeroplane and boat spotter. He will stand at our window in
Newport, Jersey City, watch something cross the sky, and want to know what it
was. Not roughly. Exactly: which aircraft, whose, coming from where, going
where.

So I built him a window that answers.

### → [hudson-window-production.up.railway.app](https://hudson-window-production.up.railway.app)

Open it and look at the sky over Jersey City right now.

![A Sikorsky S-76 named in a glass card on the left, with its shadow crossing the painted field on the right, over a figure looking up at it.](docs/screenshot.jpg)

## What it does

Leave it open on a screen near the window. When something passes, it tells you
what it is: the model, the airline, the tail number, where the flight started
and where it is going. Then it tells you one thing worth knowing about that
particular aircraft, because knowing the 737 is the best-selling jetliner ever
built is more fun than knowing its altitude.

The main view is a painted field with a small figure standing in it, looking up.
The shadows crossing the grass are real aircraft. A shadow comes in from the
side the plane is really on, travels the way it is really going, and grows as it
gets closer. When a helicopter goes over, you see a helicopter.

If you do want the numbers, they are folded away under *Show me the numbers*:
bearings, range, height and speed for everything in range, and a calibrated view
of your window.

![The details panel open, showing the calibrated window view with an Airbus H135 marked in it, and the contact list below giving bearing, range, height and speed for each aircraft.](docs/screenshot-details.jpg)

## How it knows

Aircraft broadcast their position constantly, and volunteers around the world
run receivers that pick that up and pool it. This app asks three of those pools
in turn and takes the first good answer. Flight routes come from a separate
free service that turns a callsign into "Newark to Denver".

None of it can be asked from a browser directly, which is the only reason there
is a server at all. It also means one small cache serves every open tab, rather
than every visitor hammering equipment that volunteers pay for themselves.

Between updates, the app works out where each aircraft must have got to, from
its heading and speed. Without that, things twitch across the sky once every few
seconds instead of moving.

## Things I cared about

**The shadows are real shadows.** Their direction and length come from where the
sun actually is, worked out from the date, the time and this specific window. In
the morning they stretch one way and by the afternoon they have swung round. The
same sun puts the figure's own shadow on the grass, so the two always agree.

**A shadow softens the higher the aircraft is.** A helicopter a few hundred
metres up lands crisp on the grass. An airliner at nine kilometres is a soft
grey smudge, because that is what happens, and because it tells you how high
something is without printing a number.

**The helicopter took three tries.** The painted shadow is not seen from
directly above; its skids hang below the cabin. Rotating it to follow the
aircraft's heading eventually flipped it over and the skids ended up on top.
Turning the silhouette the other way round rather than rotating it fixed it.

**Nothing on screen is a round number somebody liked.** The corner radius of the
panels comes from the corner of the painting itself. Every panel sits inside the
one behind it so that the curves are concentric rather than merely close.

**The empty sky matters most.** Measuring this actual window, there is something
within five kilometres about half the time. So the screen most people see most
often is the one saying nothing is up there, which made it the most important
sentence in the app and the one I had thought about least. It rotates gently
now, and changes at most once a minute so it does not flicker while you read it.

**The glass is doing more than it looks.** The panels pick up the colour of the
painting behind them, which is lovely until it eats the text. I measured the
contrast of every line of type against what actually ends up behind it, rather
than trusting my eye, and tuned the glass until it all stayed readable.

## What I would do next

**Boats.** He watches those too, and the whole pipeline is already built and
quietly running: vessel tracking, hulls that point the way they are going, their
own colour. It is switched off because the Hudson deserves better than a dot,
and because a ferry, a tug shoving a barge and a cruise ship should not all look
alike.

**Go deeper on each aircraft.** Right now it names the model and tells you one
thing about it. The really interesting question is about the specific airframe
in the sky: how old it is, who flew it before, whether it is the oldest one still
in service. That is a different kind of fact, and a better one.

**A logbook.** Spotters keep lists. If it quietly recorded what went over, the
app stops being a live view and becomes a collection: what you saw this month,
the first time a type showed up, the one that only comes through on Sundays.

**Tell him when something unusual passes.** Most of what crosses this window is
the same Newark departures. The pleasure is in the exception, so the app should
know the difference and say so, rather than leaving him to notice.

**Let the night back in.** There is a night painting, and the app knows exactly
where the sun is. It is pinned to daylight for now. Unpinning it is nearly free
and the window is at its best after dark anyway.

## Running it yourself

```bash
node server.mjs --demo    # invented traffic, no internet needed
node server.mjs           # the real sky, on http://localhost:8808
```

Nothing to install. No dependencies, no build step, no framework: one server
file, one page. Node 22 or newer.

It needs to know where your window is and which way it faces. Ours is at
`40.7215, -74.0339` looking due east across the Hudson. Yours goes in
`HW_LAT` and `HW_LON`, and the facing is the first setting under *Tell me about
your window*.

Get the facing right and everything else follows. If you measure it with a phone
compass, tick the box: a phone reads about 13 degrees off from true north here,
and the app will correct it.

| | |
|---|---|
| `HW_LAT` / `HW_LON` | Where the window is. |
| `AISSTREAM_KEY` | For boats. Optional; aircraft work without it. |
| `PORT` | Defaults to 8808. |

## House rules

Things I want kept if this is ever picked up again:

- No dependencies, no build step, no framework.
- `node server.mjs --demo` has to keep working with no network at all, so the
  whole thing can be tried on a train.
- Both the light and dark looks stay correct, and colours come from the tokens
  at the top of the stylesheet. Never hardcoded.
- Air and water each have their own colour, consistently, so you can read the
  screen at a glance.
- The short cache in front of the aircraft feed stays. It is what keeps this
  polite to the volunteers running the receivers.

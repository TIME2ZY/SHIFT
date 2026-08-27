# Duration .toISOString() emits floating point artifacts in the seconds field

## Describe the bug

`dayjs.duration().toISOString()` can emit floating point artifacts because sub-second precisions are added as floats and never rounded at the seconds field. For example, when adding 2 to 0.812 seconds (which is how the seconds component is calculated in `.toISOString()`), IEEE-754 gives `2.8120000000000003`:

```js
dayjs.duration(-2812).toISOString()
// '-PT2.8120000000000003S' — expected '-PT2.812S'
dayjs.duration(3121632.27382247).toISOString()
// 'PT52M1.6320000000000001S' — expected 'PT52M1.632S'
dayjs.duration(7647826.525774224).toISOString()
// 'PT2H7M27.826999999999998S' — expected 'PT2H7M27.827S'
```

## Expected behavior

The seconds component of the ISO string must be rounded to millisecond precision, so no floating point tail leaks into the output.

## Root cause hint

In `src/plugin/duration/index.js` (the `toISOString` path), the milliseconds are folded into seconds with `seconds += Math.round(this.$d.milliseconds) / 1000`, which adds a float to the seconds value before rendering.

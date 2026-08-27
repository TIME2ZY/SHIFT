# UTC plugin: getting incorrect clone after .utcOffset(0, true)

## Describe the bug

After a zero offset is set while keeping local time the clones I get with the `dayjs` constructor are not the same.

```js
var d1 = dayjs('2023-10-23 14:00:00').utcOffset(0, true)
var d2 = dayjs(d1)
d1.format() // '2023-10-23T14:00:00Z'
d2.format() // '2023-10-23T11:00:00Z'
```

## Expected behavior

Both the original instance and its clones must be the same.

## Information

- Day.js Version v1.10.4 (but reproducible with later versions)
- OS: Windows 11
- Browser: Chrome 119
- Time zone: GMT+03:00

## Possible reason

In the `utc` plugin source, if the second parameter of `.utcOffset` is set to `true` the plugin forcibly sets the UTC flag (`$u`) to `true` when the first parameter is zero. That is incorrect because when the flag is `true` the hours for a clone are initialized with plain `Date.getUTCHours`, but the date in the original instance is stored with the local timezone.

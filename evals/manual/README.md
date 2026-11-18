# Manual check fixtures

Small `.tab` files for checking by eye, in the running app, what the automated evals can't see: the editor's syntax colours and the live preview beside them. Each file isolates one behaviour of the `Q`/`@`/`L` editorial highlights.

Open them in the dev app (Cmd+O). Don't double-click them in Finder if a release Tabbo is also installed: it owns `.tab` files and will open them instead.

The export column is the reference: the preview should colour exactly what an exported PDF (Shift+Cmd+E) colours. Line numbers are the file's own.

| File | Preview | Editor | Export |
|---|---|---|---|
| `01-barline-highlight.tab` | Barlines from line 5 (`bQ`) and line 11 (`bL`) grey; the chords after them (lines 6 and 12) fully black | `bQ` and `bL` grey with a tint behind them; plain `b` lines untinted | The same two barlines grey, nothing else |
| `02-highlight-red.tab` | Red: the flag from line 3 (`1Q`), the barline from line 5 (`bQ`), and the flag and its dot from line 6 (`2@`). Line 9's `-highlightred` applies to the whole file, earlier lines included | `1Q`, `bQ`, and `2@` red; delete line 9 and they turn grey | The same four elements red |
| `03-highlight-paren.tab` | Line 5's flag (`2Qa`) between the lute font's parens, which look like square brackets; line 7's barline (`bQ`) grey, because barlines never take parens | `2Q` keeps the normal flag colour; `bQ` grey with a tint | The same parens and grey barline |
| `04-at-sign-barline.tab` | Line 4's `b@` an ordinary black barline: only `Q` or `L` marks a barline | `b@` plain | No colour anywhere |

`04` is a control: it should look the same in every build.

Checks that need a long score - editor highlighting while scrolling far down - need a file of several thousand lines; none is kept in the repo.

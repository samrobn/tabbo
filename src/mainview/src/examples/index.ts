/**
 * Example .tab files for the dropdown selector.
 */

export interface Example {
  name: string
  description: string
  content: string
}

export const examples: Example[] = [
  {
    name: 'Simple',
    description: 'Basic tablature with barlines and fermata',
    content: `% Simple lute tablature example
b
1-abc dDo
2-efg hG
Y-
e`
  },
  {
    name: 'Chords',
    description: 'Multiple voices with rhythm flags',
    content: `% Chord progression example
b
S3
1abd a
xf
#2d  c
xc
b
1.ab  d
2 a
#2  d
bb
e`
  },
  {
    name: 'Ornaments',
    description: 'Various ornament symbols',
    content: `% Ornament examples
% + cross, * dot, # hash, x small x

b
1 +a *b #c xd
b
1 'e ,f ^g
b
e`
  },
  {
    name: 'Text',
    description: 'Title and text annotations',
    content: `{A Simple Piece}

{For Renaissance Lute}

b
1-abc dDo
2-efg hG
b
1-abc dDo
2-efg hG
Y-
e`
  }
]

export function getExampleByName(name: string): Example | undefined {
  return examples.find(e => e.name === name)
}

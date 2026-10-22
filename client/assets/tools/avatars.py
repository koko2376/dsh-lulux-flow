"""Generate the project's avatar SVGs (gemini-cli, qwen-code,
dsh-agent, lulux-flow). The author's own claude-code/codex/grok PNGs are not
generated or touched. Run: python3 client/assets/tools/avatars.py"""
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'avatars'

BLOBS = {
    'gemini-cli': 'M110 34 C130 18 166 20 186 34 C222 48 238 86 234 126 C230 184 200 224 136 228 C72 232 30 200 26 140 C22 92 44 60 72 46 C86 38 98 40 110 34 Z',
    'qwen-code': 'M120 30 C150 26 168 36 182 30 C214 26 238 66 232 128 C226 190 190 226 130 228 C70 230 26 192 28 130 C30 76 70 36 120 30 Z',
    'dsh-agent': 'M128 30 C192 26 232 64 232 122 C232 180 204 224 134 226 C68 228 28 194 26 134 C24 72 64 34 128 30 Z',
    'lulux-flow': 'M118 30 C138 22 160 30 176 30 C214 30 236 72 232 126 C228 184 196 226 132 228 C70 230 28 196 26 136 C24 84 70 40 118 30 Z',
}

# body, light rim, dark rim, bottom band
PALETTES = {
    'gemini-cli': ('#3d7df5', '#86afff', '#2453b8', '#dbe7ff'),
    'qwen-code': ('#6a50f2', '#a493ff', '#4630b8', '#e6e0ff'),
    'dsh-agent': ('#4d6bfe', '#93a6ff', '#3149c4', '#e0e6ff'),
    'lulux-flow': ('#12a594', '#62d6c6', '#0b6f63', '#cdf5ee'),
}

MARKS = {
    # four-point sparkle
    'gemini-cli': '<path d="M78 50 C80.6 69 84.5 73.5 103 76 C84.5 78.5 80.6 83 78 102 C75.4 83 71.5 78.5 53 76 C71.5 73.5 75.4 69 78 50 Z" fill="#fff"/>',
    # hexagonal Q
    'qwen-code': '<g fill="none" stroke="#fff" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round"><path d="M78 52 L98 63.5 L98 86.5 L78 98 L58 86.5 L58 63.5 Z"/><path d="M85 88 L98 105"/></g>',
    # target
    'dsh-agent': '<circle cx="78" cy="76" r="20.5" fill="none" stroke="#fff" stroke-width="7"/><circle cx="78" cy="76" r="8.5" fill="#fff"/>',
    # LULUX Flow: a branching flow — one node forking into two (a tiny DAG), not a waterway
    'lulux-flow': '<g fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round"><path d="M68 76 C82 76 82 60 94 60"/><path d="M68 76 C82 76 82 92 94 92"/></g>'
                  '<rect x="50" y="66" width="20" height="20" rx="6" fill="#fff"/><rect x="92" y="51" width="18" height="18" rx="5.5" fill="#fff"/><rect x="92" y="83" width="18" height="18" rx="5.5" fill="#fff"/>',
}

EYES = (
    '<rect x="137" y="114" width="30" height="64" rx="15" fill="#fff" transform="rotate(-12 152 146)"/>'
    '<rect x="176" y="106" width="30" height="64" rx="15" fill="#fff" transform="rotate(-12 191 138)"/>'
)


def svg(name: str) -> str:
    blob = BLOBS[name]
    body, light, dark, band = PALETTES[name]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs><clipPath id="body"><path d="{blob}"/></clipPath></defs>
  <g transform="translate(130 128) scale(1.07) translate(-130 -128)">
    <path d="{blob}" transform="translate(6 6)" fill="{dark}"/>
    <path d="{blob}" transform="translate(-5 -3)" fill="{light}"/>
    <path d="{blob}" fill="{body}"/>
    <g clip-path="url(#body)"><ellipse cx="120" cy="222" rx="74" ry="21" fill="{band}" opacity=".92"/></g>
    {EYES}
    <g transform="translate(7 9)">{MARKS[name]}</g>
  </g>
</svg>
'''


if __name__ == '__main__':
    for name in BLOBS:
        (OUT / f'{name}.svg').write_text(svg(name))
        print('wrote', OUT / f'{name}.svg')

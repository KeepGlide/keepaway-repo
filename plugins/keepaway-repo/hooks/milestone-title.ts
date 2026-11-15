// The milestone's label as the pane heading and the band both show it: the title up to the first " · ", then cut at a word.
import { cutAtWord } from './model'

export const TITLE_SEPARATOR = ' · '
// The longest milestone title on its heading, in characters, the ellipsis counted (Mock S delta 11, Q9, Q17).
const MILESTONE_TITLE_MAX = 40

// The milestone title up to the first " · " (repo-work-pane-design-spec.md section 3.1).
export function titleLabel(title: string): string {
  return title.split(TITLE_SEPARATOR)[0] ?? title
}

// A milestone's title as the pane heading and the band show it: titleLabel, then cut at MILESTONE_TITLE_MAX characters, the ellipsis
// counted, at the last space before the limit.
export function headingTitleOf(title: string): string {
  return cutAtWord(titleLabel(title), MILESTONE_TITLE_MAX)
}

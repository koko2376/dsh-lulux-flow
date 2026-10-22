/** Inline stroke icons (own artwork, 20px grid, currentColor). */
import type { ReactElement, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

const make = (paths: ReactElement) =>
  function Icon({ size = 16, ...rest }: IconProps): ReactElement {
    return (
      <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
        {paths}
      </svg>
    )
  }

export const IconPlus = make(<path d="M10 4v12M4 10h12" />)
export const IconPlay = make(<path d="M6.5 4.5v11l9-5.5z" />)
export const IconStop = make(<rect x="5" y="5" width="10" height="10" rx="2" />)
export const IconResume = make(<><path d="M5 4.5v11" /><path d="M8.5 4.5v11l8-5.5z" /></>)
export const IconRerun = make(<><path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9" /><path d="M15.5 3.5v3.5H12" /></>)
export const IconSave = make(<><path d="M4.5 4.5h9l2 2v9h-11z" /><path d="M7 4.5v4h6v-4M7 15.5v-4h6v4" /></>)
export const IconTrash = make(<><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6" /></>)
export const IconDownload = make(<><path d="M10 3.5v9M6.5 9l3.5 3.5L13.5 9" /><path d="M4 15.5h12" /></>)
export const IconUpload = make(<><path d="M10 12.5v-9M6.5 7L10 3.5 13.5 7" /><path d="M4 15.5h12" /></>)
export const IconSparkles = make(<><path d="M9 3l1.4 3.6L14 8l-3.6 1.4L9 13l-1.4-3.6L4 8l3.6-1.4z" /><path d="M15 12.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" /></>)
export const IconClock = make(<><circle cx="10" cy="10" r="6.5" /><path d="M10 6.5V10l2.5 1.5" /></>)
export const IconWebhook = make(<><circle cx="6" cy="13.5" r="2" /><circle cx="14" cy="13.5" r="2" /><circle cx="10" cy="5.5" r="2" /><path d="M8 13.5h4M9 7.3l-2.2 4.4M11 7.3l2.2 4.4" /></>)
export const IconCheck = make(<path d="M4.5 10.5l3.5 3.5 7.5-8" />)
export const IconX = make(<path d="M5 5l10 10M15 5L5 15" />)
export const IconChevronDown = make(<path d="M5.5 8l4.5 4.5L14.5 8" />)
export const IconSearch = make(<><circle cx="9" cy="9" r="5" /><path d="M13 13l3.5 3.5" /></>)
export const IconLayout = make(<><rect x="3" y="4" width="5" height="4" rx="1.2" /><rect x="12" y="4" width="5" height="4" rx="1.2" /><rect x="7.5" y="12" width="5" height="4" rx="1.2" /><path d="M5.5 8v2h9V8M10 10v2" /></>)
export const IconWarning = make(<><path d="M10 3.5l7 12.5H3z" /><path d="M10 8.5v3.5M10 14.3v.2" /></>)
export const IconRefresh = make(<><path d="M15.5 8.5A5.5 5.5 0 0 0 5 7M4.5 11.5A5.5 5.5 0 0 0 15 13" /><path d="M5 3.5V7h3.5M15 16.5V13h-3.5" /></>)
export const IconGauge = make(<><path d="M3.5 14a6.5 6.5 0 1 1 13 0" /><path d="M10 14l3-4" /></>)
export const IconShield = make(<><path d="M10 3l6 2.2v4.3c0 3.6-2.6 6.2-6 7.5-3.4-1.3-6-3.9-6-7.5V5.2z" /></>)
export const IconCopy = make(<><rect x="7" y="7" width="9" height="9" rx="2" /><path d="M13 7V5a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 4 5v6.5A1.5 1.5 0 0 0 5.5 13H7" /></>)
export const IconHistory = make(<><path d="M4 10a6 6 0 1 0 1.8-4.3" /><path d="M4 3.5V6h2.5M10 7v3.2l2.2 1.3" /></>)
export const IconBeaker = make(<><path d="M8 3.5v5L4.2 15a1 1 0 0 0 .9 1.5h9.8a1 1 0 0 0 .9-1.5L12 8.5v-5M7 3.5h6M6 12.5h8" /></>)
export const IconSettings = make(<><circle cx="10" cy="10" r="2.5" /><path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M4.9 15.1l1.4-1.4M13.7 6.3l1.4-1.4" /></>)

export const IconSidebar = make(<><rect x="3" y="4" width="14" height="12" rx="2.5" /><path d="M8 4v12" /></>)

export const NodeIcons = {
  input: make(<><path d="M3.5 10h9M9.5 6.5l3.5 3.5-3.5 3.5" /><path d="M13 4h2.5a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H13" /></>),
  output: make(<><path d="M7.5 10h9M13.5 6.5L17 10l-3.5 3.5" /><path d="M7 4H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1H7" /></>),
  agent: make(<><rect x="4" y="6" width="12" height="9" rx="3" /><path d="M10 3.5V6M8 10.5v.5M12 10.5v.5" /></>),
  kernel: make(<><rect x="3" y="4" width="14" height="12" rx="2.5" /><path d="M6.5 8.5L9 10.5l-2.5 2M10.5 13h3" /></>),
  script: make(<path d="M7.5 5.5L4 10l3.5 4.5M12.5 5.5L16 10l-3.5 4.5" />),
  http: make(<><circle cx="10" cy="10" r="6.5" /><path d="M3.5 10h13M10 3.5c2 2 2.8 4.2 2.8 6.5S12 14.5 10 16.5C8 14.5 7.2 12.3 7.2 10S8 5.5 10 3.5z" /></>),
  condition: make(<><path d="M10 3.5l6.5 6.5-6.5 6.5L3.5 10z" /><path d="M8.3 10h3.4" /></>),
  loop: make(<><path d="M5 8.5A4.5 4.5 0 0 1 9.5 4h3M15 11.5a4.5 4.5 0 0 1-4.5 4.5h-3" /><path d="M11 2.5L12.5 4 11 5.5M9 14.5L7.5 16 9 17.5" /></>),
  approval: make(<><path d="M10 3l6 2.2v4.3c0 3.6-2.6 6.2-6 7.5-3.4-1.3-6-3.9-6-7.5V5.2z" /><path d="M7.3 10l1.9 1.9 3.6-3.8" /></>),
  notify: make(<><path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.3 1.5H4.2z" /><path d="M8.5 16.5a1.6 1.6 0 0 0 3 0" /></>),
} as const

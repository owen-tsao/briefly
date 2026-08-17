import type { BrieflyApi } from '../../preload/index'

declare global {
  interface Window {
    briefly: BrieflyApi
  }
}

export {}

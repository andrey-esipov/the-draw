// Standalone app: every capability link is a bare origin fragment
// (`${PUBLIC_URL}/#invite=…`, `${PUBLIC_URL}/#return=…`). There is no `/draw`
// mount point to nest under — the app is served from the root of its own
// origin — so any caller minting one of these links must go through this
// single helper rather than re-deriving the shape ad hoc.
export type DrawFragmentLinkKind = 'invite' | 'return';

export function fragmentLink(publicUrl: string, kind: DrawFragmentLinkKind, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/#${kind}=${encodeURIComponent(token)}`;
}

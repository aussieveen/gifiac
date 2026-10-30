import { DesktopEditor } from './DesktopEditor'
import { MobileEditor } from './MobileEditor'
import { type Props, useCaptionEditor } from './useCaptionEditor'
import type { EditorLayout } from './useEditorLayout'

export type { EditorSource } from './useCaptionEditor'

/** The caption/trim editor. State and behaviour live in `useCaptionEditor`;
 * this picks the layout that renders it, live, so crossing 1024px keeps
 * every caption, the trim and the playhead. */
export function CaptionEditor({ layout = 'desktop', ...props }: Props & { layout?: EditorLayout }) {
  const editor = useCaptionEditor(props)
  return layout === 'mobile' ? <MobileEditor editor={editor} /> : <DesktopEditor editor={editor} />
}

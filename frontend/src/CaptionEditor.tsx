import { DesktopEditor } from './DesktopEditor'
import type { EditorLayout } from './useEditorLayout'
import { type Props, useCaptionEditor } from './useCaptionEditor'

export type { EditorSource } from './useCaptionEditor'

/** The caption/trim editor. State and behaviour live in `useCaptionEditor`;
 * this just picks the layout that renders it. */
export function CaptionEditor({ layout = 'desktop', ...props }: Props & { layout?: EditorLayout }) {
  const editor = useCaptionEditor(props)
  void layout
  return <DesktopEditor editor={editor} />
}

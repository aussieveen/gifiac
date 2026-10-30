import { DesktopEditor } from './DesktopEditor'
import { type Props, useCaptionEditor } from './useCaptionEditor'

export type { EditorSource } from './useCaptionEditor'

/** The caption/trim editor. State and behaviour live in `useCaptionEditor`;
 * this just picks the layout that renders it. */
export function CaptionEditor(props: Props) {
  const editor = useCaptionEditor(props)
  return <DesktopEditor editor={editor} />
}

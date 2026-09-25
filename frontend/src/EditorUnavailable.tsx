import { useState } from 'react'
import { Link } from 'react-router-dom'
import mark from './assets/brand/strewthgif-mark.svg'

/** Mirrors Archive.tsx's copyToClipboard fallback — kept local rather than
 * shared since it's the only other caller so far. */
async function copyToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) {
      throw new Error('execCommand copy failed')
    }
  } finally {
    document.body.removeChild(textarea)
  }
}

/** Rendered instead of the video picker / caption editor when the window is
 * too narrow to use them (see useCanEdit) — reached either by shrinking
 * below the breakpoint before ever opening the editor, or by a direct link
 * to /new or /edit/:id on a phone. */
export function EditorUnavailable() {
  const [copied, setCopied] = useState(false)

  async function handleCopyLink() {
    await copyToClipboard(window.location.href)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="editor-unavailable">
      <img src={mark} alt="" className="editor-unavailable-mark" />
      <h1 className="editor-unavailable-heading">The editor needs a bigger screen</h1>
      <p className="editor-unavailable-body">
        Making GIFs needs a computer or a tablet in landscape. Everything else works here.
      </p>
      <div className="editor-unavailable-actions">
        <Link className="btn btn-primary" to="/library">
          Back to library
        </Link>
        <button type="button" className="btn btn-secondary" onClick={handleCopyLink}>
          {copied ? 'Link copied' : 'Copy link to this page'}
        </button>
      </div>
    </div>
  )
}

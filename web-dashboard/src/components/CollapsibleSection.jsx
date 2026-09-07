import { useState } from 'react'

export default function CollapsibleSection({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`section ${open ? 'open' : ''}`}>
      <div className="section-header" onClick={() => setOpen(!open)}>
        <h3>{title}</h3>
        <span className="chevron">&#9656;</span>
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  )
}

export default function StatusBadge({ level }) {
  const cls = (level || '').toLowerCase()
  return <span className={`badge ${cls}`}>{level}</span>
}

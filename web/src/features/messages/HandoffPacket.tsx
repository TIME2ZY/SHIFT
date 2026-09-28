import type { HandoffPacket as HandoffPacketData } from "../../shared/contracts/handoff-fence";

/**
 * A handoff fence as the successor seat needs to read it: route and intent on
 * one line, then the contract fields. Long progress text collapses so the
 * packet stays scannable in the message flow.
 */
export function HandoffPacket({ packet }: { packet: HandoffPacketData }) {
  return (
    <section
      className="react-handoff-packet"
      aria-label="交接报文"
      data-intent={packet.intent || undefined}
    >
      <header className="react-handoff-packet-head">
        <span className="react-handoff-packet-intent">{packet.intentLabel || "交接"}</span>
        <span className="react-handoff-packet-route">{packet.to ? `→ ${packet.to}` : null}</span>
      </header>
      <div className="react-handoff-packet-fields">
        {packet.scalars.map((entry) =>
          entry.field === "what" ? (
            <details key={entry.field} className="react-handoff-packet-long">
              <summary>
                <span className="react-handoff-packet-label">{entry.label}</span>
                <span className="react-handoff-packet-preview">{entry.value.split("\n")[0]}</span>
              </summary>
              <pre className="react-handoff-packet-body">{entry.value}</pre>
            </details>
          ) : (
            <div key={entry.field} className="react-handoff-packet-field">
              <span className="react-handoff-packet-label">{entry.label}</span>
              <p className="react-handoff-packet-value">{entry.value}</p>
            </div>
          )
        )}
        {packet.lists.map((entry) => (
          <div key={entry.field} className="react-handoff-packet-field">
            <span className="react-handoff-packet-label">{entry.label}</span>
            <ul className="react-handoff-packet-list">
              {entry.items.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

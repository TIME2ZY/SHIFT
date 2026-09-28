import type { ContractCard as ContractCardData } from "../../shared/contracts/contract-fence";
import { IdChip } from "../../shared/ui/IdChip";

/**
 * An agent-authored fence is a contract, not a source listing. Render the
 * route/verdict on the head, then the fields the successor seat has to act on.
 * Long progress text collapses so the packet stays scannable in the flow.
 */
export function ContractCard({ card }: { card: ContractCardData }) {
  return (
    <section className="react-contract-card" aria-label={card.title} data-fence={card.id}>
      <header className="react-contract-card-head">
        <span className="react-contract-card-title">{card.title}</span>
        {card.badge ? <span className="react-contract-card-badge">{card.badge}</span> : null}
      </header>
      <div className="react-contract-card-fields">
        {card.fields.map((field) =>
          field.id ? (
            <div key={field.key} className="react-contract-card-field">
              <span className="react-contract-card-label">{field.label}</span>
              <span className="react-contract-card-value">
                <IdChip value={field.value} label={field.label} digits={12} />
              </span>
            </div>
          ) : field.long ? (
            <details key={field.key} className="react-contract-card-long">
              <summary>
                <span className="react-contract-card-label">{field.label}</span>
                <span className="react-contract-card-preview">{field.value.split("\n")[0]}</span>
              </summary>
              <p className="react-contract-card-body">{field.value}</p>
            </details>
          ) : (
            <div key={field.key} className="react-contract-card-field">
              <span className="react-contract-card-label">{field.label}</span>
              <p className="react-contract-card-value">{field.value}</p>
            </div>
          )
        )}
        {card.lists.map((list) => (
          <div key={list.key} className="react-contract-card-field">
            <span className="react-contract-card-label">{list.label}</span>
            <ul className="react-contract-card-list">
              {list.items.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

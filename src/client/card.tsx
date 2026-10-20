/**
 * The Google Cloud provider card on the Models page.
 *
 * It renders inside the row DSH already shows for this provider, so the plugin
 * adds no settings entry of its own. The card starts collapsed and shows the
 * connection state; its own toggle reveals the fields, which keeps the row the
 * same shape as the shipped ones.
 */
import type { ReactNode } from 'react'
import './harness.js'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardFace, CardView } from './form.js'

const styles = `
.gcx-card{display:grid;gap:10px;padding-top:2px}
.gcx-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.gcx-summary{min-width:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.gcx-body{display:grid;gap:14px}
.gcx-field{display:grid;gap:6px}
.gcx-label{font-size:13px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-primary)}
.gcx-input,.gcx-textarea{box-sizing:border-box;width:100%;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}
.gcx-input:focus,.gcx-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.gcx-input[data-invalid=true],.gcx-textarea[data-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
.gcx-textarea{min-height:96px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;resize:vertical}
.gcx-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.gcx-hint[data-tone=warn]{color:var(--dsw-alias-state-warn-primary)}
.gcx-hint[data-tone=error]{color:var(--dsw-alias-state-error-primary)}
.gcx-hint[data-tone=success]{color:var(--dsw-alias-state-success-primary)}
.gcx-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.gcx-button{appearance:none;border:1px solid transparent;border-radius:8px;padding:6px 14px;font:inherit;font-size:12px;font-weight:500;line-height:1.4;cursor:pointer}
.gcx-button[data-kind=primary]{background:var(--dsw-alias-brand-primary);color:#fff}
.gcx-button[data-kind=secondary]{background:transparent;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.gcx-button[data-kind=quiet]{background:transparent;color:var(--dsw-alias-label-secondary);padding:2px 4px}
.gcx-button:disabled{opacity:.5;cursor:default}
`

/** One line describing the provider without opening the form. */
function summaryOf(view: CardView): string {
  const labels = view.labels
  const project = view.projectId.trim() === '' ? labels.unconfigured : view.projectId.trim()
  const key = view.keyConfigured ? labels.apiKeySet : labels.apiKeyUnset
  return `${labels.projectId}: ${project} · ${key.replace(/[.。]$/, '')} · ${labels.models}: ${view.modelCount}`
}

/** Render the provider card. */
export function ProviderCard(props: PropsRuntime<'settings.models.provider-card'>): ReactNode {
  const face = props as unknown as CardFace
  const view = face.useCard((value) => value)
  const labels = view.labels
  const disabled = !view.writable || view.saving
  const showForm = view.expanded && view.status !== 'unavailable'

  return (
    <div className="gcx-card">
      <style>{styles}</style>
      <div className="gcx-head">
        <span className="gcx-summary">{summaryOf(view)}</span>
        <button
          className="gcx-button"
          data-kind="quiet"
          type="button"
          onClick={() => {
            if (view.expanded) face.collapse()
            else face.expand()
          }}
        >
          {view.expanded ? labels.collapse : labels.expand}
        </button>
      </div>
      {view.status === 'loading' ? <p className="gcx-hint">{labels.loading}</p> : null}
      {view.status === 'unavailable' ? (
        <p className="gcx-hint" data-tone="warn">
          {labels.unavailable}
        </p>
      ) : null}
      {view.status !== 'unavailable' && !view.writable ? (
        <p className="gcx-hint" data-tone="warn">
          {labels.readOnly}
        </p>
      ) : null}
      {showForm ? (
        <div className="gcx-body">
          <div className="gcx-field">
            <label className="gcx-label" htmlFor="gcx-project">
              {labels.projectId}
            </label>
            <input
              id="gcx-project"
              className="gcx-input"
              type="text"
              spellCheck={false}
              autoComplete="off"
              disabled={disabled}
              data-invalid={view.invalid === 'project'}
              placeholder="my-project-123456"
              value={view.projectId}
              onChange={(event) => face.edit('projectId', event.target.value)}
            />
            {view.invalid === 'project' ? (
              <p className="gcx-hint" data-tone="error">
                {labels.projectIdMissing}
              </p>
            ) : (
              <p className="gcx-hint">{labels.projectIdHint}</p>
            )}
          </div>
          <div className="gcx-field">
            <label className="gcx-label" htmlFor="gcx-location">
              {labels.location}
            </label>
            <input
              id="gcx-location"
              className="gcx-input"
              type="text"
              spellCheck={false}
              autoComplete="off"
              disabled={disabled}
              placeholder="global"
              value={view.location}
              onChange={(event) => face.edit('location', event.target.value)}
            />
            <p className="gcx-hint">{labels.locationHint}</p>
          </div>
          <div className="gcx-field">
            <label className="gcx-label" htmlFor="gcx-proxy">
              {labels.proxy}
            </label>
            <input
              id="gcx-proxy"
              className="gcx-input"
              type="text"
              spellCheck={false}
              autoComplete="off"
              disabled={disabled}
              placeholder="socks5://127.0.0.1:1080"
              value={view.proxy}
              onChange={(event) => face.edit('proxy', event.target.value)}
            />
            <p className="gcx-hint">{labels.proxyHint}</p>
          </div>
          <div className="gcx-field">
            <label className="gcx-label" htmlFor="gcx-key">
              {labels.apiKey}
            </label>
            <input
              id="gcx-key"
              className="gcx-input"
              type="password"
              spellCheck={false}
              autoComplete="new-password"
              disabled={disabled || !view.keyWritable}
              placeholder={view.keyConfigured ? '••••••••' : 'AIza…'}
              value={view.keyDraft}
              onChange={(event) => face.editKey(event.target.value)}
            />
            <p className="gcx-hint" data-tone={view.keyConfigured ? 'success' : undefined}>
              {view.keyConfigured ? `${labels.apiKeySet} ` : `${labels.apiKeyUnset} `}
              {labels.apiKeyHint}
            </p>
          </div>
          <div className="gcx-field">
            <label className="gcx-label" htmlFor="gcx-models">
              {`${labels.advanced} · ${labels.models}`}
            </label>
            <textarea
              id="gcx-models"
              className="gcx-textarea"
              spellCheck={false}
              disabled={disabled}
              data-invalid={view.invalid === 'models'}
              value={view.modelsText}
              onChange={(event) => face.edit('modelsText', event.target.value)}
            />
            {view.invalid === 'models' ? (
              <p className="gcx-hint" data-tone="error">
                {labels.modelsInvalid}
              </p>
            ) : (
              <p className="gcx-hint">{labels.modelsHint}</p>
            )}
          </div>
          <div className="gcx-actions">
            <button
              className="gcx-button"
              data-kind="primary"
              type="button"
              disabled={disabled || !view.dirty || view.invalid !== null}
              onClick={() => face.save()}
            >
              {view.saving ? labels.saving : labels.save}
            </button>
            <button
              className="gcx-button"
              data-kind="secondary"
              type="button"
              disabled={disabled || (!view.dirty && view.keyDraft === '')}
              onClick={() => face.reset()}
            >
              {labels.reset}
            </button>
            {view.notice === 'saved' ? (
              <span className="gcx-hint" data-tone="success">
                {labels.saved}
              </span>
            ) : view.failure !== null ? (
              <span className="gcx-hint" data-tone="error">
                {view.failure === 'rejected' ? labels.rejected : view.failure}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

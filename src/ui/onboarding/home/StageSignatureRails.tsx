import { SIGNATURE_TRACKS, type SignatureBlock } from './stageSignature';

/** Compact, monochrome project fingerprint used only in the recent-project list. */
export function StageSignatureRails({ blocks, className = '' }: { blocks: SignatureBlock[]; className?: string }) {
  return <div className={`ph-signature ${className}`} aria-hidden="true">
    {SIGNATURE_TRACKS.map((track) => <div className="ph-signature__track" key={track}>
      {blocks.filter((block) => block.track === track).map((block, index) =>
        <span key={index} className="ph-rail-block"
          style={{ left: `${block.start}%`, width: `${block.length}%` }} />)}
    </div>)}
  </div>;
}

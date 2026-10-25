import React from 'react';
import { AlertTriangle, X, Download } from 'lucide-react';

interface SafeCloseDialogProps {
  isOpen: boolean;
  activeCount: number;
  onCancel: () => void;
  onConfirmExit: () => void;
}

export const SafeCloseDialog: React.FC<SafeCloseDialogProps> = ({
  isOpen,
  activeCount,
  onCancel,
  onConfirmExit,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs select-none">
      <div className="relative w-full max-w-md bg-[#12151a] border border-[#f85149]/40 rounded-xl shadow-2xl p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-[#da3633]/15 text-[#f85149] shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-white">Active Downloads in Progress</h3>
            <p className="text-xs text-[#8b949e] mt-1 leading-relaxed">
              There {activeCount === 1 ? 'is' : 'are'} currently{' '}
              <span className="font-semibold text-white font-mono">{activeCount}</span> active media{' '}
              {activeCount === 1 ? 'transfer' : 'transfers'} running. Closing VANTA now will terminate
              background extraction and conversion processes.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="p-1 text-[#8b949e] hover:text-white rounded transition-colors"
            aria-label="Cancel exit dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 rounded-lg bg-[#161b22] border border-[#21262d] text-[11px] text-[#8b949e] font-mono">
          Tip: You can pause downloads before closing to cleanly resume them next time.
        </div>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            className="px-3.5 py-1.5 text-xs text-[#c9d1d9] bg-[#21262d] hover:bg-[#30363d] rounded-lg transition-colors font-medium"
          >
            Stay in App
          </button>
          <button
            onClick={onConfirmExit}
            className="px-4 py-1.5 text-xs font-medium text-white bg-[#da3633] hover:bg-[#f85149] rounded-lg transition-colors shadow-sm"
          >
            Terminate & Exit
          </button>
        </div>
      </div>
    </div>
  );
};

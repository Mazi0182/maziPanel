import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[maziPanel] Kök uygulama hatası yakalandı:', error, errorInfo);
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0a0b0e] text-silver-100 flex items-center justify-center p-4">
          <div className="glass-panel bg-zinc-950/90 border border-white/10 rounded-3xl p-8 max-w-md w-full text-center flex flex-col items-center gap-5 shadow-2xl relative overflow-hidden">
            {/* Background ambient lighting */}
            <div className="absolute -top-16 -right-16 w-32 h-32 bg-white/5 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute -bottom-16 -left-16 w-32 h-32 bg-white/5 rounded-full blur-3xl pointer-events-none" />

            <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-silver-300">
              <AlertTriangle className="w-6 h-6" />
            </div>

            <div className="space-y-2">
              <h1 className="text-lg font-semibold text-white tracking-wide">
                Bir Sorun Oluştu
              </h1>
              <p className="text-xs text-silver-400">
                Uygulama çalışırken beklenmeyen bir hata meydana geldi. Lütfen sayfayı yenileyerek tekrar deneyin.
              </p>
              {this.state.error?.message && (
                <div className="mt-3 p-3 rounded-xl bg-white/[0.03] border border-white/10 text-left">
                  <p className="text-[11px] font-mono text-silver-400 break-words line-clamp-3">
                    {this.state.error.message}
                  </p>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={this.handleReload}
              className="w-full py-2.5 px-4 rounded-xl bg-white hover:bg-silver-200 text-black text-xs font-semibold flex items-center justify-center gap-2 transition-all shadow-lg active:scale-95 cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              Sayfayı Yenile
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

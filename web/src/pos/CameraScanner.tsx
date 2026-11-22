/** Reading a barcode or QR code with the camera, in browsers that can (BarcodeDetector). The apps use the phone's own scanner. */

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { Modal } from '../ui';

interface Detector { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> }
interface DetectorClass { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> }

const WANTED = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];

export function CameraScanner({ onScan, onClose }: { onScan: (code: string | null) => void; onClose: () => void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(onScan);
  done.current = onScan;
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    void (async () => {
      try {
        const Cls = (window as unknown as { BarcodeDetector: DetectorClass }).BarcodeDetector;
        const supported = await Cls.getSupportedFormats();
        const detector = new Cls({ formats: WANTED.filter((f) => supported.includes(f)) });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const tick = async () => {
          if (stopped || !video.current) return;
          try {
            const [hit] = await detector.detect(video.current);
            if (hit?.rawValue) {
              stopped = true;
              done.current(hit.rawValue);
              return;
            }
          } catch {
            /* a frame that could not be read */
          }
          timer = setTimeout(() => void tick(), 180);
        };
        void tick();
      } catch (e) {
        setError((e as Error).name === 'NotAllowedError' ? t('Allow the camera to scan.') : t('The camera could not be started.'));
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [t]);
  return (
    <Modal title={t('Scan with the camera')} onClose={onClose}>
      <div className="stack">
        <video ref={video} className="camera-view" playsInline muted />
        {error ? <p className="form-error" role="alert">{error}</p> : <p className="small muted">{t('Hold the code inside the frame.')}</p>}
      </div>
    </Modal>
  );
}

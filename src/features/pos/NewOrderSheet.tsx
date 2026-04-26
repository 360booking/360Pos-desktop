/**
 * New-order sheet — Sprint 9 / non-table intake.
 *
 * Opens from the "Comandă nouă" button in TablesPane and lets the
 * operator pick a source other than a seated table:
 *
 *   - Masă        → falls through to TablesPane's normal flow
 *                   (we close the sheet without creating).
 *   - Walk-in     → ORDER_CREATED with source='walkin', no tableId,
 *                   no customer fields. Customer name optional.
 *   - Delivery    → opens the delivery sub-form (name/phone/address/notes)
 *                   then ORDER_CREATED with source='home_delivery'.
 *
 * No payment-link, no external delivery providers, no fiscalisation.
 * The created draft order goes through the same outbox + sync as a
 * table order.
 */
import { useState } from 'react';
import { ChairIcon, PersonIcon, TruckIcon } from './_NewOrderIcons';
import { X } from 'lucide-react';

interface NewOrderSheetProps {
  onClose: () => void;
  onPickWalkIn: (customerName?: string, notes?: string) => void;
  onPickDelivery: (customer: {
    customerName: string;
    customerPhone: string;
    customerAddress: string;
    notes?: string;
  }) => void;
  onPickTable: () => void;
}

type Step = 'pick' | 'delivery' | 'walkin';

export function NewOrderSheet({
  onClose,
  onPickWalkIn,
  onPickDelivery,
  onPickTable,
}: NewOrderSheetProps) {
  const [step, setStep] = useState<Step>('pick');
  const [walkInName, setWalkInName] = useState('');
  const [walkInNotes, setWalkInNotes] = useState('');
  const [deliveryName, setDeliveryName] = useState('');
  const [deliveryPhone, setDeliveryPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryNotes, setDeliveryNotes] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-950/95 p-5 shadow-2xl">
        <header className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-white">
            {step === 'pick' && 'Comandă nouă'}
            {step === 'walkin' && 'Walk-in'}
            {step === 'delivery' && 'Comandă livrare'}
          </h3>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </header>

        {step === 'pick' && (
          <div className="grid grid-cols-1 gap-2">
            <SourceButton
              icon={<ChairIcon />}
              label="La masă"
              hint="Alege o masă din panoul din stânga"
              onClick={() => {
                onPickTable();
                onClose();
              }}
            />
            <SourceButton
              icon={<PersonIcon />}
              label="Walk-in / la pachet"
              hint="Client în picioare, fără masă"
              onClick={() => setStep('walkin')}
            />
            <SourceButton
              icon={<TruckIcon />}
              label="Livrare la adresă"
              hint="Cere date client + adresă"
              onClick={() => setStep('delivery')}
            />
          </div>
        )}

        {step === 'walkin' && (
          <div className="space-y-3">
            <label className="block">
              <span className="text-[12px] uppercase tracking-wider text-slate-400 font-semibold">
                Nume client (opțional)
              </span>
              <input
                value={walkInName}
                onChange={(e) => setWalkInName(e.target.value)}
                placeholder="ex: Andrei"
                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-400/60"
              />
            </label>
            <label className="block">
              <span className="text-[12px] uppercase tracking-wider text-slate-400 font-semibold">
                Notițe (opțional)
              </span>
              <input
                value={walkInNotes}
                onChange={(e) => setWalkInNotes(e.target.value)}
                placeholder="ex: fără ceapă"
                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-400/60"
              />
            </label>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setStep('pick')}
                className="touch-target flex-1 rounded-xl py-2.5 text-sm font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60"
              >
                Înapoi
              </button>
              <button
                type="button"
                onClick={() => {
                  onPickWalkIn(
                    walkInName.trim() || undefined,
                    walkInNotes.trim() || undefined,
                  );
                  onClose();
                }}
                className="touch-target flex-1 rounded-xl py-2.5 text-sm font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-900/40"
              >
                Creează walk-in
              </button>
            </div>
          </div>
        )}

        {step === 'delivery' && (
          <DeliveryForm
            name={deliveryName}
            phone={deliveryPhone}
            address={deliveryAddress}
            notes={deliveryNotes}
            onNameChange={setDeliveryName}
            onPhoneChange={setDeliveryPhone}
            onAddressChange={setDeliveryAddress}
            onNotesChange={setDeliveryNotes}
            onBack={() => setStep('pick')}
            onSubmit={() => {
              if (!deliveryName.trim() || !deliveryPhone.trim() || !deliveryAddress.trim()) {
                return;
              }
              onPickDelivery({
                customerName: deliveryName.trim(),
                customerPhone: deliveryPhone.trim(),
                customerAddress: deliveryAddress.trim(),
                notes: deliveryNotes.trim() || undefined,
              });
              onClose();
            }}
          />
        )}
      </div>
    </div>
  );
}

function SourceButton({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="touch-target flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] hover:border-violet-400/60 p-3 text-left"
    >
      <span className="text-violet-300">{icon}</span>
      <span className="flex-1">
        <span className="block text-sm font-semibold text-white">{label}</span>
        <span className="block text-[11px] text-slate-400">{hint}</span>
      </span>
    </button>
  );
}

interface DeliveryFormProps {
  name: string;
  phone: string;
  address: string;
  notes: string;
  onNameChange: (v: string) => void;
  onPhoneChange: (v: string) => void;
  onAddressChange: (v: string) => void;
  onNotesChange: (v: string) => void;
  onBack: () => void;
  onSubmit: () => void;
}

function DeliveryForm(p: DeliveryFormProps) {
  const isValid = p.name.trim() && p.phone.trim() && p.address.trim();
  return (
    <div className="space-y-3">
      <Field label="Nume client *" value={p.name} onChange={p.onNameChange} placeholder="ex: Maria Pop" />
      <Field label="Telefon *" value={p.phone} onChange={p.onPhoneChange} placeholder="07XX XXX XXX" />
      <Field
        label="Adresă *"
        value={p.address}
        onChange={p.onAddressChange}
        placeholder="ex: Str. Avram Iancu 12, ap. 4"
      />
      <Field label="Notițe" value={p.notes} onChange={p.onNotesChange} placeholder="ex: interfon stricat" />
      <div className="flex gap-2 pt-2">
        <button
          type="button"
          onClick={p.onBack}
          className="touch-target flex-1 rounded-xl py-2.5 text-sm font-semibold bg-slate-700/40 text-slate-200 border border-white/10 hover:bg-slate-700/60"
        >
          Înapoi
        </button>
        <button
          type="button"
          disabled={!isValid}
          onClick={p.onSubmit}
          className="touch-target flex-1 rounded-xl py-2.5 text-sm font-semibold bg-gradient-to-r from-violet-600 to-indigo-600 text-white shadow-lg shadow-violet-900/40 disabled:opacity-50"
        >
          Creează livrare
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-[12px] uppercase tracking-wider text-slate-400 font-semibold">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-400/60"
      />
    </label>
  );
}

# 360booking POS pentru Windows — instalare și test (Etapa 5)

Aplicația de Windows deschide **POS-ul web** al restaurantului, rulează singură
**agentul casei de marcat** (modulul Rust testat pe Datecs DP-25X) și are o
**casă offline**: dacă pică internetul, nota se închide pe stație, bonul fiscal
se tipărește local, iar plata ajunge pe server când revine internetul.

> Ce trebuie să fie deja pe server: POS-ul web cu „puntea desktop”
> (`frontend` commit „POS web în aplicația desktop de Windows (Etapa 5)…”).
> Fără el aplicația merge (POS web + agent fiscal), dar notele nu ajung în
> casa offline.

---

## 1. Descarcă instalatorul din GitHub Actions

1. Intră pe <https://github.com/360booking/360Pos-desktop/actions>.
2. În stânga alege **pos-desktop-windows-tenant**.
3. Deschide ultima rulare **verde** pe ramura `etapa5-pos-web-offline`
   (pornește singură la fiecare modificare pe ramura asta; altfel
   **Run workflow** → ramura `etapa5-pos-web-offline` → **Run workflow**,
   ~10–15 minute).
4. Jos, la **Artifacts**, descarcă **360booking-pos-windows-tenant** (zip).
5. Dezarhivează: în `nsis/` e `360booking POS_…_x64-setup.exe`, în `msi/`
   e `.msi`. Oricare merge; recomandat `setup.exe`.

> Artefactul se păstrează 14 zile. Build-ul **demo** (`pos-desktop-windows-demo`)
> e pentru prezentări, nu pentru casa reală.

## 2. Instalează

1. Dacă ai versiunea veche instalată, nu e nevoie s-o dezinstalezi — se
   actualizează peste. Datele locale (înrolarea casei, setările) rămân.
2. Rulează `setup.exe`. Windows poate afișa „Windows a protejat PC-ul”
   (aplicația nu e semnată încă): **Mai multe informații → Rulează oricum**.
3. Pornește **360booking POS**.

## 3. Prima pornire — configurarea stației

1. Apare ecranul **Configurare stație POS**.
2. La **Adresa restaurantului** scrie adresa din 360booking, de ex.
   `pizzeria.360booking.ro` (sau domeniul propriu al restaurantului) →
   **Testează** → trebuie să scrie „… răspunde”.
3. Bifează după nevoie:
   - **Mod chioșc** — ecran complet, fără bară de titlu (Ctrl+Shift+K îl
     pornește/oprește oricând);
   - **Pornește odată cu Windows**.
4. **Salvează și deschide POS-ul** → se deschide POS-ul web. Te
   autentifici o singură dată (cont de ospătar/casier); la repornire
   rămâi logat.

Scurtături în aplicație:

| Tastă | Ce face |
|---|---|
| **Ctrl+Shift+F** | fereastra **Casă de marcat și stație** |
| **Ctrl+Shift+O** | **Casa offline** |
| **Ctrl+Shift+K** | mod chioșc pornit/oprit |

## 4. Conectează casa de marcat

1. Leagă casa (DP-25X) prin cablu/USB și porneşte-o. În Windows →
   Manager dispozitive → Porturi (COM și LPT) vezi portul (ex. `COM3`).
2. În aplicație: **Ctrl+Shift+F** → tab **Casă de marcat**.
3. Secțiunea **Configurare hardware**: Provider „Datecs DP-25”, portul
   COM, baud 115200 sau 9600 (ce a găsit diagnosticul), operator și
   parolă → **Salvează + Test now** → trebuie `online: true`.
4. Dacă stația **nu e înrolată** (prima instalare): în adminul web
   (Restaurant → Casă de marcat) generează un cod de activare, apoi în
   secțiunea **Bridge backend** lipește codul → **Claim + start WSS**.
   O singură dată; după aceea agentul pornește singur la fiecare pornire
   a aplicației.
5. Sus, în cardul de stare, trebuie să vezi:
   - **Agent fiscal: integrat (Rust)** — 🟢 *conectat la server*;
   - **Casa de marcat** — 🟢 *răspunde*, „Ultimul răspuns: acum …”.

> Dacă vezi „fiscal-bridge separat”: stația nu are încă înrolare în
> aplicație și folosește vechiul fiscal-bridge inclus. După pasul 4 trece
> singură pe agentul integrat (setarea **Avansat → Agent fiscal: Automat**).

## 5. Test bon + raport X (cu internet)

1. În POS-ul web: deschide o masă, adaugă un produs ieftin (ex. 1 leu),
   **Plătește → Numerar**.
2. Bonul trebuie să iasă pe casă în câteva secunde.
3. **Ctrl+Shift+F** → **Raport X (local)** → iese raportul X (nu
   golește memoria zilei, se poate rula oricând).
4. Testează și **Raport X** din adminul web (Restaurant → Rapoarte) — trece
   prin server → agent → casă.

## 6. Test fără internet (casa offline)

Pregătire: cu internetul pornit, deschide 1–2 note în POS-ul web (cu
produse, **fără reducere/bacșiș**) și lasă POS-ul deschis cel puțin
10 secunde, ca notele să ajungă în cache-ul stației.

1. **Scoate cablul de rețea** (sau oprește Wi-Fi-ul).
2. După ~10 secunde apare jos-stânga pastila roșie **Fără internet →
   Casa offline**. Apasă-o (sau Ctrl+Shift+O, sau încearcă să încasezi o
   notă — apare mesajul cu butonul **Casa offline**).
3. În **Casa offline** apar notele deschise. Alege o notă → verifică
   produsele și cota TVA → **Numerar** sau **Card (terminal separat)** →
   **Încasează și tipărește bonul**.
4. Trebuie să iasă bonul fiscal și să apară „Bon fiscal **N** tipărit”.
5. Tab-ul **Jurnal offline**: rândul are bonul N și starea „de
   sincronizat”.
6. **Pune cablul la loc.** După ~20 de secunde aplicația se întoarce
   singură la POS-ul web (sau **Înapoi la POS online**). În cel mult
   30 de secunde apare „N bonuri emise offline au fost trimise la server”.
7. Verifică în adminul web că nota e **plătită** și are bonul **N** (nu se
   emite un al doilea bon). În **Jurnal offline** rândul e „sincronizat”.

### Ce mai merită verificat

- **Conflict:** offline închizi o notă; de pe alt dispozitiv (telefon cu
  date mobile) adaugi un produs pe aceeași notă. La revenire plata se
  înregistrează, bonul rămâne, iar rândul din jurnal apare **galben, de
  verificat** („Nota s-a modificat…”). Dacă nota a fost anulată sau deja
  încasată pe server, plata NU se trimite, rândul rămâne „conflict” —
  verifici și, dacă e cazul, faci storno.
- **Casa oprită în timpul bonului / aplicația închisă forțat:** rândul
  devine „neclar — verifică rola”. Uită-te pe rolă: **A ieșit** (scrii
  numărul BF) sau **Nu a ieșit** (nota se poate închide din nou). Aplicația
  nu retipărește niciodată singură.
- **Casa deconectată:** scoate cablul casei → în ~1 minut pastila
  „Casa de marcat nu răspunde”; pune cablul înapoi → **Reconectează acum**
  (sau așteaptă ~20 s) → „răspunde”.
- **Pornire fără internet:** pornește aplicația cu cablul scos — se
  deschide direct Casa offline.
- **Repornire:** închide și redeschide aplicația — rămâi logat, agentul
  fiscal se reconectează singur (cardul din Ctrl+Shift+F).

## 7. Ce NU face casa offline (deocamdată)

- nu modifică produsele notei și nu deschide note noi;
- nu închide note cu reducere, bacșiș sau plată parțială (se închid online);
- o singură metodă de plată pe notă (numerar sau card);
- cota TVA vine de la server pe fiecare produs; dacă lipsește se folosește
  cota implicită a stației (Ctrl+Shift+F → Stație → Avansat, implicit 21%)
  și e marcată cu * pe ecran.

## 8. Dacă ceva nu merge

- Jurnalul aplicației: `%LOCALAPPDATA%\com.x360booking.pos\logs\`.
- Date locale: `%APPDATA%\com.x360booking.pos\` (`pos-offline.db` = jurnalul
  bonurilor offline — **nu-l șterge** cât are rânduri nesincronizate).
- F12 deschide DevTools (consola) în orice fereastră.
- Revenire la interfața veche: Ctrl+Shift+F → Stație → Avansat →
  Interfață: „POS desktop vechi”.

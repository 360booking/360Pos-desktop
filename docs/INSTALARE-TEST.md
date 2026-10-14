# 360restaurants POS pentru Windows — instalare și test (Etapa 5)

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
5. Dezarhivează: în `nsis/` e `360restaurants POS_…_x64-setup.exe`, în `msi/`
   e `.msi`. Oricare merge; recomandat `setup.exe`.

> Artefactul se păstrează 14 zile. Build-ul **demo** (`pos-desktop-windows-demo`)
> e pentru prezentări, nu pentru casa reală.

## 2. Instalează

1. Dacă ai versiunea veche instalată, nu e nevoie s-o dezinstalezi — se
   actualizează peste. Datele locale (înrolarea casei, setările) rămân.
2. Rulează `setup.exe`. Windows poate afișa „Windows a protejat PC-ul”
   (aplicația nu e semnată încă): **Mai multe informații → Rulează oricum**.
3. Pornește **360restaurants POS**.

## 3. Prima pornire — configurarea stației

1. Apare un singur ecran: **Adresa restaurantului**.
2. Scrie adresa din 360booking, de ex. `pizzeria.360booking.ro` (sau
   domeniul propriu al restaurantului) → **Continuă**. Aplicația verifică
   adresa și deschide POS-ul web. Te autentifici o singură dată; la
   repornire rămâi logat.
3. Mod chioșc și pornirea odată cu Windows nu mai apar la prima pornire:
   sunt în fereastra **Casa de marcat** (Ctrl+Shift+F) → tab **Setări
   aplicație**. Implicit aplicația pornește pe tot ecranul (F11 comută).

Scurtături în aplicație:

| Tastă | Ce face |
|---|---|
| **Ctrl+Shift+F** | fereastra **Casa de marcat** (pentru service) |
| **Ctrl+Shift+O** | **Casa offline** |
| **Ctrl+Shift+K** | mod chioșc pornit/oprit |

## 4. Conectează casa de marcat

Casa de marcat se configurează **doar din aplicație**, dintr-un singur loc:
în POS, ca administrator, **Setări → Casa de marcat** (pagina
`/admin/restaurant/fiscal`, secțiunea **Casa de marcat**) → **Configurează
casa de marcat**. Aplicația se leagă singură de restaurant (fără cod de
copiat) și se deschide fereastra **Casa de marcat**. Sus vezi mereu două
lumini:

- **Casa de marcat:** *răspunde* / *nu răspunde* / *neconfigurată*;
- **Legătura cu restaurantul:** *conectată* / *nelegată*.

Dacă totul e deja configurat și legat, fereastra se deschide direct pe
„Gata! Casa de marcat e pregătită.” Într-un browser obișnuit, pagina din
admin arată doar starea casei și textul „Casa de marcat se configurează
doar din aplicația 360restaurants POS pentru Windows”.

### Pasul 1 — Găsește casa de marcat

1. Pornește casa și leag-o cu cablul USB de calculator.
2. La **Ce casă de marcat ai?** alege **Datecs DP-25X** (sau DP-25 /
   DP-150X). Restul modelelor sunt gri — nu sunt suportate încă.
3. Apasă **Caută casa automat**. Aplicația încearcă pe rând porturile COM
   („Încerc COM4 la 115200…”) și completează singură portul și viteza care
   au răspuns. Durează câteva secunde pe portul bun și până la ~20 s pe
   fiecare port greșit.
   - Dacă nu o găsește: **Aleg eu portul** → alegi portul din listă (cu
     numele dat de Windows) și viteza.
4. **Operator** și **Parolă** sunt deja completate cu valorile din fabrică
   (1 / 0001). Le schimbi doar dacă le-a modificat service-ul casei.
5. **Salvează și testează** → trebuie să apară **„Casa răspunde ✓”**. Dacă
   nu, mesajul spune ce să verifici (cablu, curent, port, alt program care
   folosește portul — ex. DUDE sau vechiul 360booking-bridge —, parolă).

Exemplu — valorile verificate pe casa noastră (Datecs DP-25X, aprilie 2026):

| Câmp | Valoare |
|---|---|
| Model | Datecs DP-25X (provider `datecs_dp25`) |
| Port | `COM4` pe PC-ul de atunci — **depinde de calculator**, îl găsește „Caută casa automat” |
| Viteză | 115200 |
| Protocol | FP-55 / DP-25 implicit (dialectul DP-25X) |
| Operator / parolă | 1 / 0001 |

### Legare (automată)

Nu mai e un pas de făcut de mână. Când pornești din **Setări → Casa de
marcat**, pagina cere serverului un cod nou (unic, valabil 10 minute) și îl
dă direct aplicației, care se leagă singură. Linia **Legare** din fereastră
arată *Legată de restaurant ✓*.

- Dacă aplicația e deja legată de restaurantul tău, nu se mai leagă din nou.
- Dacă e legată de **alt** restaurant, pagina întreabă înainte.
- Dacă legarea nu reușește, linia **Legare** arată motivul și butonul
  **Reîncearcă legarea** (redeschide în POS pagina Setări → Casa de marcat,
  care reface legarea).
- Deschisă cu Ctrl+Shift+F fără legare, fereastra spune „Deschide Setări →
  Casa de marcat din POS”.
- Codul manual a rămas doar în **Avansat (service)**.

### Pasul 3 — Bon de test

1. **Tipărește un bon de test de 1 leu** → iese un bon fiscal real de 1 leu,
   numerar, cota A (procentul apare doar dacă e cunoscut din configurarea
   restaurantului). Rămâne în raportul zilei — e normal.
2. **Raport X (nu închide ziua)** → iese raportul X.
3. Apare **„Gata! Casa de marcat e pregătită.”** și ambele lumini sus sunt
   verzi.

### Avansat (service)

Jos, închis implicit: toate uneltele tehnice de dinainte, neschimbate —
formularul complet (provider, port, baud, variantă protocol, operator,
parolă, adaptor Rust, loguri brute), înrolare cu alt server, test conexiune /
status, pull config, pairing manual, probe (dialect × baud), raw bytes dump,
starea agentului fiscal integrat. Doar pentru tehnician. (Programul separat
fiscal-bridge nu mai există: agentul integrat e singurul.)

## 5. Test bon + raport X (cu internet)

1. În POS-ul web: deschide o masă, adaugă un produs ieftin (ex. 1 leu),
   **Plătește → Numerar**.
2. Bonul trebuie să iasă pe casă în câteva secunde.
3. **Ctrl+Shift+F** → **Raport X (nu închide ziua)** → iese raportul X (nu
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
  fiscal se reconectează singur (luminile de sus din Ctrl+Shift+F).

## 7. Ce NU face casa offline (deocamdată)

- nu modifică produsele notei și nu deschide note noi;
- nu închide note cu reducere, bacșiș sau plată parțială (se închid online);
- o singură metodă de plată pe notă (numerar sau card);
- nu emite bonuri dacă stația nu are casa configurată (provider „simulator”);
  pentru un test fără casă reală există bifa *Avansat → Permite casa offline
  cu simulatorul* — **doar pe o stație de test**, fiindcă numărul de bon
  simulat ajunge pe server ca bon offline;
- cota TVA vine de la server pe fiecare produs; dacă lipsește se folosește
  cota implicită a aplicației (Ctrl+Shift+F → Setări aplicație, implicit 21%)
  și e marcată cu * pe ecran.

## 8. Dacă ceva nu merge

- Jurnalul aplicației: `%LOCALAPPDATA%\com.x360booking.pos\logs\`.
- Date locale: `%APPDATA%\com.x360booking.pos\` (`pos-offline.db` = jurnalul
  bonurilor offline — **nu-l șterge** cât are rânduri nesincronizate).
- F12 deschide DevTools (consola) în orice fereastră.
- Revenire la interfața veche: Ctrl+Shift+F → Setări aplicație →
  Interfață: „POS desktop vechi”.

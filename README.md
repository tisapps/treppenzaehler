# Treppenzähler (PWA)

Zählt Treppenstufen, Stockwerke und Höhenmeter – ohne Barometer, nur mit Beschleunigungssensor und Gyroskop.

## Starten
Statisch über HTTPS ausliefern (z. B. GitHub Pages), in Chrome auf Android öffnen, „Zum Startbildschirm hinzufügen“.
Lokal: `python3 -m http.server` (Sensoren gibt es nur über HTTPS bzw. localhost).

## Dateien
- `detector.js` – Erkennungskern (Browser + Node)
- `app.js`, `index.html` – Oberfläche, Kalibrierung, Rohdaten-Aufnahme, Tagesverlauf
- `tools/sim-test.js` – Test mit synthetischen Daten: `node tools/sim-test.js`
- `tools/replay.js` – echte Aufnahme abspielen: `node tools/replay.js aufnahme.csv`

## Verfahren
1. Schwerkraftrichtung per Tiefpass → vertikale Beschleunigung, Gierrate um die Hochachse.
2. Schritte = Spitzen der vertikalen Beschleunigung.
3. Pro Schritt Merkmale (Dauer, Spitze-Spitze, horizontaler Anteil, Ruck, Neigungsschwung, Schiefe, vertikaler Hub der Hüfte)
   → Klassifikation eben / hoch / runter / hoch mit 2 Stufen pro Schritt (Gauß-Naive-Bayes, per Kalibrierung gelernt).
4. Aufeinanderfolgende Treppenschritte = Lauf; 180°-Wenden (Gyroskop) trennen Läufe am Podest.
5. Läufe mit Wende davor/danach werden auf bekannte Lauflängen (5 / 10) eingerastet; dabei wird auch
   „2 Stufen pro Schritt“ als Lesart geprüft und der Wechsel kurz/lang bevorzugt.

### Schutz gegen Fehlzählungen beim Gehen in der Ebene
- Schritt zählt erst als Stufe, wenn er deutlich (Strenge) besser zu „Treppe“ passt als zu „eben“.
- Merkmale über zwei Schritte gemittelt (Handy nur an einer Seite → links/rechts verschieden).
- Ein Lauf braucht im Mittel genug Treppenmerkmale und mindestens 70 % treppenartige Einzelschritte.
- Standardmäßig nur Läufe mit 180°-Wende davor/danach; sehr kurze Läufe (< 4 Schritte) nur innerhalb einer Serie.
- Kalibrierung ignoriert die Podestschritte rund um Wenden; danach wird die Trennschärfe angezeigt.

## Bekannte Grenze
Chrome pausiert Bewegungssensoren, sobald der Bildschirm aus ist oder die Seite im Hintergrund liegt.
Eine reine PWA zählt deshalb nur bei eingeschaltetem Bildschirm (Option „Bildschirm anlassen“).
Für Zählung bei ausgeschaltetem Bildschirm braucht es eine native Android-Hülle mit Vordergrunddienst.

<img src="extension/icons/icon.svg" alt="" width="72" height="72">

# PTB Reload

Firefox-Erweiterung, die einen Tab zu einem festgelegten Zeitpunkt neu lädt, zum Beispiel beim Start eines Ticket-Vorverkaufs. Die Zeit kommt direkt von der Uhr der Physikalisch-Technischen Bundesanstalt auf [uhr.ptb.de](https://uhr.ptb.de), die Systemuhr wird nur als Zwischenschritt genutzt.

Das Projekt gehört nicht zur PTB. Es nutzt den WebSocket `wss://uhr.ptb.de/time`, über den auch die PTB-Webuhr läuft. Der Endpunkt ist nicht offiziell dokumentiert und kann sich ändern.

<img src="docs/popup.png" alt="Popup der Erweiterung" width="320">

## Installation

Die Schritte für Firefox stehen in [INSTALL.md](INSTALL.md). Nötig ist Firefox 142 oder neuer.

## Benutzung

1. Die Seite öffnen, die neu geladen werden soll.
2. Auf das Symbol von PTB Reload klicken.
3. Zeitpunkt eintragen und **Aktuellen Tab scharf schalten** wählen.
4. Tab und Fenster sichtbar lassen und den Computer nicht schlafen legen. Oben rechts auf der Seite läuft ein Countdown mit Abbrechen-Knopf.

Nach dem Reload zeigt das Popup, wie weit Auslösung, Navigation, Request und erstes Byte vom Soll entfernt lagen. Liegt der Zeitpunkt mehr als 5 Sekunden zurück, zum Beispiel nach dem Ruhezustand, lädt die Erweiterung nicht mehr neu und meldet das.

## Optionen

| Option | Wirkung | Empfehlung |
|---|---|---|
| Versatz in ms | Verschiebt den Zeitpunkt. Positive Werte lösen später aus. | Nach Bedarf, etwa `+200`, wenn die Server-Uhr nachgehen könnte |
| Hard-Reload | Lädt ohne Cache und öffnet dabei immer eine neue Verbindung. Vorwärmen ist dann deaktiviert. | Aus |
| Verbindung vorwärmen | Schickt in zwei Runden je 4 `HEAD`-Anfragen an `/favicon.ico` der Seite, zuletzt etwa 4 Sekunden vorher. Der Reload nutzt danach die offene Verbindung. | An |
| Vorlauf bis 30 ms | Löst früher aus, um die geschätzte Laufzeit zum Server auszugleichen. | Aus |

Beim Vorlauf kennt die Erweiterung nur die Gesamtlaufzeit einer Anfrage und nicht die Serverzeit darin. Antwortet das Favicon langsam, wird die Strecke überschätzt und der Reload kommt zu früh. Die Obergrenze von 30 ms begrenzt diesen Fehler, verhindert ihn aber nicht. Eine zu frühe Anfrage bekommt die alte Seite, ein paar Millisekunden Verspätung schaden dagegen kaum.

## Genauigkeit

Gemessen mit Firefox 159 im Headless-Modus und einem lokalen Server. Die Netzlaufzeit hat ein Proxy simuliert, ohne HTTPS. Angegeben ist die Ankunft am Server relativ zum Soll. Jede Zeile umfasst 4 bis 10 Läufe.

| Netz hin/zurück | Einstellung | Ankunft |
|---|---|---|
| lokal | Tab sichtbar | +3 bis +7 ms |
| 15/15 ms | ohne Vorwärmen | +52 bis +55 ms |
| 15/15 ms | Vorwärmen | +16 bis +19 ms |
| 40/40 ms | ohne Vorwärmen | etwa +126 bis +130 ms |
| 40/40 ms | Vorwärmen | +44 bis +47 ms |
| 40/40 ms | Vorwärmen und Vorlauf | +16 bis +19 ms |
| 5/5 ms, Favicon 100 ms langsam | Vorwärmen und Vorlauf | −24 bis −15 ms |

Die absolute Genauigkeit gegenüber der PTB liegt bei etwa ±10 ms, weil Hin- und Rückweg zur PTB nie exakt gleich lang sind. Die größte Unbekannte bleibt die Uhr des Ticket-Servers. Sie kann deutlich stärker abweichen als alle Werte in dieser Tabelle.

## Datenschutz und Berechtigungen

Die Erweiterung erhebt keine Daten und hat kein eigenes Backend. An uhr.ptb.de gehen nur Zeitstempel. Mit aktivem Vorwärmen gehen die oben genannten Anfragen an die geöffnete Seite, einschließlich ihrer Cookies.

`tabs` braucht sie, um den Tab neu zu laden und seinen Zustand zu verfolgen. `<all_urls>` braucht sie, um den Countdown in die gewählte Seite einzufügen und danach die Ladezeiten auszulesen.

Automatisches Neuladen kann gegen die AGB eines Shops verstoßen. Die Erweiterung löst pro Planung genau einen Reload aus.

## Entwicklung

```bash
npm ci
npm run lint          # web-ext lint, Warnungen zählen als Fehler
npm run build         # ZIP in web-ext-artifacts/
npm run dev           # Firefox mit geladener Erweiterung starten
npm run test:smoke    # echter Reload-Test, braucht geckodriver
npm run test-server   # loggt jede Anfrage in PTB-Zeit
```

Der Testserver läuft auf `http://127.0.0.1:8123/`. Er zeigt für jede Anfrage die Abweichung zur nächsten vollen Sekunde, damit sich ein geplanter Reload direkt prüfen lässt.

`extension/` enthält nur das, was im Paket landet:

- `background.js` misst die PTB-Zeit und verwaltet den geplanten Reload.
- `trigger.js` läuft im Ziel-Tab, zählt die letzten Millisekunden aktiv ab und löst aus.
- `popup.*` ist die Oberfläche.

## Release und Signierung

Normales Firefox installiert dauerhaft nur von Mozilla signierte Erweiterungen. Für die Signierung ohne öffentlichen Eintrag im Add-on-Katalog:

1. Unter [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/) einen API-Schlüssel erzeugen.
2. Beide Werte als Repository-Secrets speichern:

   ```bash
   gh secret set AMO_JWT_ISSUER
   gh secret set AMO_JWT_SECRET
   ```

3. `version` in `extension/manifest.json` erhöhen, committen und den passenden Tag pushen:

   ```bash
   git tag v1.2.0
   git push origin v1.2.0
   ```

Der Workflow baut das ZIP, signiert bei vorhandenen Secrets eine `.xpi` und hängt beides an ein GitHub-Release. Ohne Secrets enthält das Release nur das unsignierte ZIP.

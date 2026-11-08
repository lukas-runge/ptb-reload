# PTB Reload installieren

Du brauchst Firefox 142 oder neuer. Die Version steht unter **Firefox > Über Firefox**.

## Mit signierter Datei (empfohlen)

Du bekommst dafür eine Datei, die auf `.xpi` endet.

1. Firefox öffnen und die `.xpi`-Datei in das Firefox-Fenster ziehen.
2. Die Nachfrage mit **Hinzufügen** bestätigen.
3. Das Puzzle-Symbol in der Symbolleiste öffnen und PTB Reload über das Zahnrad an die Symbolleiste anheften.

Die Erweiterung bleibt danach auch nach einem Neustart installiert.

Meldet Firefox, die Erweiterung sei beschädigt oder nicht verifiziert, ist die Datei nicht signiert. Dann nimm den folgenden Weg oder bitte um eine signierte Datei.

## Ohne Signatur (bis zum nächsten Firefox-Neustart)

Du bekommst dafür eine `.zip`-Datei.

1. In die Adresszeile `about:debugging#/runtime/this-firefox` eingeben.
2. **Temporäres Add-on laden** anklicken und die `.zip`-Datei auswählen.

Firefox entfernt die Erweiterung beim Beenden. Lade sie also vor dem Vorverkauf und lass Firefox danach offen.

## Vor dem Ernstfall testen

1. Irgendeine Seite öffnen und auf das Symbol von PTB Reload klicken.
2. Oben muss eine laufende Uhrzeit stehen. Steht dort weiter `Verbinde mit uhr.ptb.de`, ist die Verbindung blockiert, oft durch eine Firewall oder einen Werbeblocker.
3. Einen Zeitpunkt etwa eine Minute in der Zukunft eintragen und **Aktuellen Tab scharf schalten** wählen.
4. Nach dem Reload wieder auf das Symbol klicken. Unter **Letzter Reload** steht die gemessene Abweichung.

## Am Tag des Vorverkaufs

- Ticket-Seite rechtzeitig öffnen und scharf schalten.
- **Verbindung vorwärmen** einschalten, **Vorlauf** ausgeschaltet lassen.
- Tab sichtbar lassen und den Computer nicht in den Ruhezustand gehen lassen.
- Kommt noch die alte Seite, einfach von Hand neu laden. Die Erweiterung lädt pro Planung nur einmal.

Für jeden Vorverkauf gilt, dass die Uhr des Ticket-Servers von der PTB-Zeit abweichen kann. Ein Reload exakt nach Atomuhr garantiert also keinen frühen Platz in der Warteschlange.

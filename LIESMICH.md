# Einsatznavigation

Browserbasierte Navigation für Einsatzfahrten mit Sperrungen, Gegenrichtung in Einbahnstraßen und Fahrzeugprofil für PKW und LKW. Die Anwendung besteht aus HTML, CSS und drei Skriptdateien (`app.js`, `verkehr.js`, `kilometer.js`) und benötigt keine Installation.

## Betrieb

Der Standortzugriff wird vom Browser nur in einem sicheren Kontext freigegeben. Die Dateien werden demnach über HTTPS oder lokal über `localhost` bereitgestellt.

**Lokal am Rechner:** Im Ordner der Dateien wird `python -m http.server 8080` ausgeführt. Anschließend wird `http://localhost:8080` aufgerufen.

**Auf dem iPhone:** Die Dateien werden auf einen beliebigen HTTPS-Webspace geladen (Netlify, GitHub Pages, eigener Server). Die Seite wird in Safari geöffnet und über Teilen › Zum Home-Bildschirm abgelegt. Sie startet danach als eigene App im Vollbild mit eigenem Symbol. Beim ersten Start werden Standort und beim Zentrieren die Bewegungsdaten (Kompass) freigegeben.

**Test am Schreibtisch:** Per langem Druck auf die Karte wird ein Startpunkt gesetzt, danach ein Ziel eingegeben und „Fahrt simulieren“ gewählt.

## Funktionen

**Zieleingabe:** Adresse eintippen und mit Enter bestätigen. Der erste Treffer wird übernommen und die Route sofort ab dem aktuellen Standort berechnet. Koordinaten im Format `51.4556, 7.0116` werden direkt erkannt. Ein langer Druck auf die Karte setzt ein Ziel ohne Eingabe.

**Sperrungen:** Über die rote Taste rechts wird der Sperrmodus aktiviert. Im Modus „Punkt“ wird die gesperrte Straße angetippt, im Modus „Fläche“ werden Eckpunkte gesetzt. Sperrungen bleiben im Browser gespeichert, werden bei jeder Berechnung umfahren und lassen sich als JSON exportieren und auf anderen Geräten importieren. Eine Punktsperre an einer Kreuzung sperrt alle Zufahrten dieser Kreuzung.

**Gegenrichtung Einbahnstraße:** Die Prüfung erfolgt in zwei Stufen. Zunächst berechnet der Routingserver neben der regulären Route mehrere Kandidaten mit aufgehobener Einbahnbeschränkung (schnellste, kürzeste und Alternativen). Für jeden Kandidaten mit Zeitgewinn wird über `trace_attributes` je Abschnitt die zulässige Fahrtrichtung abgefragt. Abschnitte entgegen der Einbahnrichtung werden somit eindeutig erkannt. Getrennte Richtungsfahrbahnen werden über `locate` an einer parallelen Fahrbahn gleichen Namens erkannt. Liefert der Server keinen zulässigen schnelleren Weg, wird ersatzweise das Straßennetz um die Route über Overpass geladen und selbst gerechnet. Abschnitte gegen die Einbahnrichtung erscheinen gelb, zusätzlich erfolgen ein Hinweis im Manöverbanner und eine Sprachansage. Regelgerecht befahrene Einbahnstraßen erscheinen in gleicher Zeichnung grün, auf jeder Route und in der 3D-Ansicht, ohne Banner oder Ansage. Liegt das Ziel in einer Einbahnstraße, vermerkt das Routenblatt „Ziel in Einbahnstraße“. Unter „Diagnose“ im Routenblatt wird jeder Prüfschritt protokolliert.

**Routenwahl:** Wird ein schnellerer Weg gegen die Einbahnrichtung gefunden, bleibt die Route ohne Gegenrichtung als graue Alternative auf der Karte sichtbar und wird mit ihrer Fahrzeit beschriftet. Im Routenblatt stehen beide Routen mit Fahrzeit und Länge zur Auswahl. Umgeschaltet wird per Tipp auf die Auswahl, auf die graue Linie oder auf deren Beschriftung. Die gewählte Variante bleibt bei Neuberechnungen bis zum nächsten Ziel erhalten.

**Verkehrslage:** Aktuelle Staus, Unfälle und Sperrungen werden auf die Route abgebildet. Berücksichtigt werden nur Meldungen in der eigenen Fahrtrichtung, ein Stau auf der Gegenfahrbahn bleibt unbeachtet. Gestaute Abschnitte erscheinen auf der Karte rot, Sperrungen schwarz gestrichelt, an der Route mit Angabe der Verzögerung. Die Verzögerung fließt in Ankunftszeit und Restzeit ein. Vor einem Stau erscheint ein roter Hinweis im Manöverbanner mit Ansage. Überschreitet die Verzögerung den Grenzwert (Standard 3 Minuten) oder liegt eine Sperrung auf der Route, werden die gestauten Abschnitte für den Routingserver ausgeschlossen und eine Umfahrung berechnet. Ist sie insgesamt schneller, wird sie gewählt. Die Route durch den Stau bleibt in der Routenwahl als „Durch Stau“ verfügbar, etwa für die Fahrt durch die Rettungsgasse, und bleibt bei Neuberechnungen gewählt. Während der Fahrt wird die Lage alle zwei Minuten aktualisiert. Entsteht ein Stau oberhalb des Grenzwerts, wird automatisch neu berechnet.

**Datenquellen Verkehr:** Ohne Schlüssel werden die Meldungen der Autobahn GmbH (verkehr.autobahn.de) für alle Autobahnen auf der Route abgefragt, einschließlich Reisezeitverlust. Mit einem kostenlosen TomTom-Schlüssel (developer.tomtom.com, Eintrag in den Einstellungen) kommen Meldungen auf allen Straßen und auf Wunsch die Verkehrsflusskarte hinzu. Meldungen beider Quellen zum selben Stau werden nur einmal gezählt.

**Kilometrierung Autobahn:** Eingabe zum Beispiel „A5 km 487,3“, „A 5 487.3“ oder „BAB A3 km 120“. Die Position wird zwischen den Kilometerpunkten interpoliert. Zur Auswahl stehen beide Fahrtrichtungen, benannt nach dem Ort rund 20 km voraus. Die Route wird auf die Richtungsfahrbahn der gewählten Fahrtrichtung geführt.

**Kilometrierung Bahn:** Eingabe zum Beispiel „Strecke 4000 km 12,345“, „4000 km 2,3 + 45“ (DB-Schreibweise) oder „Bahn 6100 12,4“. Angegeben wird die Streckennummer nach VzG, nicht die Kursbuchnummer. Mit „Strecke 4000“ ohne Kilometer wird die ganze Strecke auf der Karte angezeigt, farbig nach Elektrifizierung (violett Oberleitung, pink Stromschiene, grau gestrichelt nicht elektrifiziert). Ein Tipp auf die Strecke zeigt den Kilometer an dieser Stelle und setzt ihn auf Wunsch als Ziel. Im Routenblatt erscheinen Streckenname, Gleisanzahl, Bahnart, Geschwindigkeit und ein deutlicher Hinweis zur Elektrifizierung. Bei Oberleitung oder Stromschiene erfolgt zusätzlich eine Ansage. Die Bahndaten entsprechen dem DB Geo-Streckennetz mit Stand 2020 und sind vor Ort zu prüfen. Die Zufahrt führt zur nächstgelegenen Straße.

**Umfeld der Bahnstelle:** Nach Wahl eines Bahnkilometers werden zusätzlich Gleislage und Lärmschutzwände ermittelt. Die Gleislage ergibt sich aus der Gleisanzahl der eigenen Strecke und parallel verlaufenden Strecken im Umkreis von 50 m: „Eingleisige Strecke“ (kein Nachbargleis), „Nachbargleislage“ (ein Nachbargleis) oder „Innengleislage möglich“ (drei oder mehr Gleise nebeneinander). Nachbarstrecken werden mit Nummer, Gleisanzahl, Elektrifizierung, Seite und Abstand genannt. Ist eine Nachbarstrecke elektrifiziert, erscheint der Hinweis, Abschaltung und Erdung auch für diese anzufordern. Für Lärmschutzwände wird je Seite angegeben, ob am Kilometer eine Wand steht, mit Höhe über Schienenoberkante, und wie weit die nächste Lücke in beide Richtungen entfernt ist, mit Kilometer. Wände und Lücken erscheinen zusätzlich auf der Karte. Links und rechts beziehen sich auf die Richtung steigender Kilometrierung. Die Daten liegen je Streckenachse vor, nicht je Gleis. Das betroffene Gleis ist daher vor Ort zu klären. Türen in Lärmschutzwänden sind im Datensatz nicht enthalten, als Lücke gilt das Ende einer Wand.

**Lärmschutzwände auf der Karte:** Bei einem Bahn- oder Autobahnziel werden alle Lärmschutzwände im Umkreis von 1,5 km dunkelgrau eingezeichnet, die nächsten Lücken an der Zielstelle grün mit Kilometer. Bei Bahnzielen stammen die Wände aus dem EBA-Datensatz. Bei Autobahnzielen stammen sie aus OpenStreetMap über Overpass, ihre Vollständigkeit ist dort nicht gesichert. Sie werden je Seite in Fahrtrichtung ausgewertet, mit Höhe, sofern erfasst, und nächster Lücke voraus und zurück. Ist der OpenStreetMap-Dienst nicht erreichbar, nennt das Hinweisfeld dies ausdrücklich.

**Zielhinweise ausblenden:** Das Hinweisfeld im Routenblatt lässt sich über das Kreuz oben rechts komplett ausblenden. Ein kleiner Knopf „Zielhinweise einblenden“ holt es zurück, bei elektrifizierter Strecke gelb mit Blitz. Die Wahl bleibt gespeichert. Eingeklappt zeigt das Routenblatt nur Kopfzeile, Elektrifizierung, Gleislage und Lärmschutzwand, aufgeklappt alle Angaben.

**Zulässigkeit der Gegenrichtung:** Autobahnen, Kraftfahrstraßen, deren Rampen und Kreisverkehre sind grundsätzlich ausgenommen. Getrennte Richtungsfahrbahnen werden an einer parallelen Gegenfahrbahn gleichen Namens erkannt und nur nach Freigabe in den Einstellungen genutzt. Poller, gesperrte Zufahrten, eingetragene Sperrungen und im LKW-Profil die Fahrzeugmaße werden auch im eigenen Wegenetz beachtet. Wird eine schnellere Gegenrichtung aus einem dieser Gründe verworfen, nennt die App Straße und Grund.

**3D-Ansicht des Ziels:** Sobald ein Ziel gesetzt ist, öffnet die Würfeltaste rechts ein zusätzliches Fenster mit einer dreidimensionalen Darstellung der Zieladresse. Gebäude werden mit ihren Höhen aus OpenStreetMap dargestellt, das Gelände mit Höhendaten. Das Zielgebäude wird rot hervorgehoben. Die Blickrichtung entspricht der Anfahrtsrichtung der gewählten Route, die Route selbst wird mit eingeblendet. Das Ziel bleibt stets in der Bildmitte. Wischen mit einem Finger dreht waagrecht um das Ziel und neigt senkrecht die Ansicht, zwei Finger zoomen. Unten links stehen Tasten für Drehen um 45°, den Wechsel zwischen 2D und 3D sowie Zoom. Über die Kopfzeile werden Luftbild, langsame Drehung, Ausrichtung auf die Anfahrt und Vollbild geschaltet. Die 3D-Bibliothek wird erst beim ersten Öffnen geladen.

**Fahrzeugprofil:** Im Profil LKW werden Höhe, Breite, Länge, Gesamtgewicht und Achslast an den Routingserver übergeben. Unterführungen, Brücken und Engstellen mit entsprechender Beschilderung werden somit gemieden, soweit diese in OpenStreetMap erfasst sind. Vorlagen für gängige Fahrzeuge sind Richtwerte und werden an die Angaben des Fahrzeugscheins angepasst.

**iPhone-Betrieb:** Die App ist als Web-App für den Home-Bildschirm eingerichtet. Ein Service Worker hält die App-Dateien und Bibliotheken vor, sodass sie auch ohne Netz startet. Bereits angezeigte Kartenkacheln werden zwischengespeichert (bis 3000 Kacheln), was in Funklöchern die Karte erhält. Routing und Adresssuche benötigen weiterhin eine Netzverbindung. App-Dateien werden stets zuerst aus dem Netz geladen, neue Versionen greifen daher sofort.

**Hochformat:** Das Routenblatt ist einklappbar. Eingeklappt zeigt es nur Ankunftszeit, Restzeit, Entfernung und die Routenwahl. Ein Tipp auf den Griff oder auf die Zeitzeile blendet Status, Diagnose und die Tasten „Übersicht“, „Fahrt simulieren“ und „Beenden“ ein. Die Stellung wird gemerkt. Passen die Kartentasten nicht zwischen Banner und Routenblatt, werden sie als Reihe unter dem Banner angeordnet. Auf kleinen Geräten öffnet die 3D-Ansicht direkt im Vollbild.

**Querformat für die Halterung:** Manöverbanner und Routenblatt stehen als Seitenleiste rechts, die Karte bleibt frei. Die eigene Position wird mittig im freien Kartenbereich gehalten, die 3D-Ansicht erscheint oben links.

**Weitere Anpassungen:** Notch und Dynamic Island werden in beiden Ausrichtungen freigehalten. Versehentliches Zoomen der Oberfläche, Textmarkierung und Kontextmenüs beim langen Druck auf die Karte sind unterbunden. Im Stand zeigt der Positionspfeil die Kompassrichtung, in Fahrt die GPS-Richtung. Sperrungen werden über das Teilen-Menü weitergegeben (AirDrop, Nachrichten, Dateien). Damit das Display während der Fahrt anbleibt, sollte unter Einstellungen › Anzeige & Helligkeit die automatische Sperre verlängert werden, falls iOS die Bildschirmsperre der App nicht zulässt.

## Eingesetzte Dienste

| Aufgabe | Dienst | Einstellung |
|---|---|---|
| Karte | OpenStreetMap, alternativ basemap.de (BKG) | Kartenstil |
| Adresssuche | Photon (komoot) | Server |
| Routing | Valhalla (FOSSGIS) | Server |
| Rückfallebene Gegenrichtung | Overpass API | Server |
| 3D-Ansicht | MapLibre GL, OpenFreeMap (Gebäude), Mapzen Terrain Tiles (Gelände), Esri World Imagery (Luftbild) | fest |
| Verkehrslage | Autobahn GmbH (verkehr.autobahn.de), TomTom Traffic (mit Schlüssel) | Verkehrslage |
| Kilometrierung Autobahn | NPGeo-Kat (vfdb), Dienst „Kilometrierungen der Bundesautobahnen“ | fest |
| Kilometrierung Bahn | NPGeo-Kat (vfdb), Dienst „Deutsche Bahn Streckennetz“ (DB Geo-Streckennetz, Stand 2020) | fest |
| Lärmschutzwände Bahn | NPGeo-Kat (vfdb), Dienst „Schallschutzwände Bahnstrecken“ (Eisenbahn-Bundesamt, Lärmkartierung Runde 4) | fest |
| Lärmschutzwände Autobahn | OpenStreetMap (wall=noise_barrier) über Overpass | Server |

Die öffentlichen Server stehen ohne Verfügbarkeitszusage zur Verfügung und sind nicht für einen Leitstellen- oder Flottenbetrieb vorgesehen. Für den dienstlichen Einsatz wird ein eigener Valhalla-Server (Docker-Image `ghcr.io/valhalla/valhalla`) mit OSM-Auszug des Einsatzgebiets betrieben und dessen Adresse unter „Server“ eingetragen. Gleiches gilt bei Bedarf für Photon und Overpass. Das Luftbild von Esri unterliegt deren Nutzungsbedingungen und ist für einen dienstlichen Dauerbetrieb gesondert zu klären.

## Grenzen

Die Datengrundlage ist OpenStreetMap. Fehlende oder veraltete Angaben zu Durchfahrtshöhen, Gewichtsbeschränkungen und Einbahnstraßen wirken sich unmittelbar auf die Route aus. Die Anwendung ersetzt weder Ortskenntnis noch die Pflicht zur Prüfung der Verkehrslage. Das Befahren einer Einbahnstraße entgegen der Fahrtrichtung ist nur im Rahmen von Sonderrechten nach § 35 StVO und unter gebührender Berücksichtigung der öffentlichen Sicherheit und Ordnung zulässig.

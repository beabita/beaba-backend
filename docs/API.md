# Référence API Beaba

Toutes les routes sont préfixées par `/api`. Sauf indication contraire, elles nécessitent un cookie de session valide (`beaba_token`), et la plupart un statut de campagne `active`.

Réponses : JSON. Erreurs : `{ "error": "...", "detail": "..." }` avec code HTTP approprié.

---

## Auth

### `POST /auth/login`

Envoie un magic link par mail.

**Body** : `{ "email": "user@example.com" }`

**Réponse** : `{ "ok": true }` même si l'email n'est pas connu (pas de leakage). Si l'envoi échoue : 500.

### `GET /auth/verify?token=<token>`

Endpoint cible du magic link. Avec `FRONTEND_URL` (front séparé), ne consomme
pas le token : redirige vers `FRONTEND_URL/login/verify?token=<token>`, où le
conseiller clique pour se connecter (les antivirus de messagerie qui ouvrent
le lien ne le grillent plus). Sans `FRONTEND_URL`, pose le cookie et redirige
vers `/app`. Token absent, perimé ou déjà utilisé : redirige vers
`/login?error=expired`.

### `POST /auth/verify`

**Body** : `{ "token": "<token>" }`. Consomme le token, pose le cookie
`beaba_token` (httpOnly, sameSite, secure). Réponse `{ "ok": true }`, ou 401
si le token est perimé ou déjà utilisé.

### `POST /auth/logout`

Efface le cookie. Réponse `{ "ok": true }`.

### `GET /auth/me`

Retourne `{ id, email, name, role }` si connecté, 401 sinon.

---

## Campaign

### `GET /campaign`

Retourne la campagne active du kit (`status='active'` ou `setup`). 200 même pour les campagnes `completed`.

### `POST /campaign`

Crée une campagne. Body : `{ household, address, expected_days, ... }`. Réponse : `{ id }`.

### `POST /campaign/:id/complete`

Passe la campagne en `completed` après relevé de fin.

---

## Rooms, Plugs, Sensors, Meters

CRUD classique scopé à la campagne active.

- `GET / POST /rooms`, `PUT / DELETE /rooms/:id`
- `GET / POST /plugs`, `PUT / DELETE /plugs/:id`
- `GET / POST /plugs/:id/appliances`, `PUT / DELETE /plugs/:id/appliances/:appId`
- `GET /plugs/:id/profile` — analyse heuristique 7 derniers jours pour suggérer une catégorie
- `GET / POST /sensors`, `PUT / DELETE /sensors/:id`
- `GET / POST /meters/readings` — relevés début/fin de campagne (eau, gaz, électricité)

Voir le code de [`src/api/`](../src/api/) pour les schémas exacts.

---

## Readings

### `GET /readings/power`

Puissance instantanée par prise (1 ligne par prise, dernière lecture).

### `GET /readings/power/history?plug_id=...&from=ISO&to=ISO`

Série temporelle pour une prise précise.

### `GET /readings/power/daily?from=YYYY-MM-DD&to=YYYY-MM-DD`

Agrégat kWh quotidien par prise. Privilégie le delta `energy_kwh` (compteur cumulatif), fallback à l'intégration moyenne `power_w × heures`.

```json
[
  {
    "date": "2026-05-14",
    "total_kwh": 8.42,
    "plugs": [{"plug_id": "...", "appliance_name": "TV", "kwh": 0.32}, ...]
  }
]
```

### `GET /readings/power/realtime?minutes=60`

Dernières N minutes de puissance (tous plugs confondus) — pour le chart temps réel du dashboard. Max `minutes=2880`.

### `GET /readings/temp`

Dernière lecture par sonde de température + nom de la pièce.

### `GET /readings/temp/history?sensor_id=&from=&to=&interval=hour|day`

Agrégat (moyenne) de température/humidité par bucket temporel.

### `GET /readings/co2`, `/readings/co2/history` — idem mais CO₂.

---

## Map

### `GET /map`

Vue consolidée pour la carto + diagnostic : pièces + leurs prises (avec dernière puissance) + dernier relevé CO₂. Pas d'historique.

---

## Comfort

### `GET /comfort/config`

Constantes du modèle physique (mur 30 cm brique, R_si, R_se, f_Rsi, seuils température/humidité, marge DIN 4108-2). Renvoie aussi les formules en texte pour affichage.

### `GET /comfort/current`

Pour chaque pièce avec des sondes : évaluation actuelle (T_paroi, T_rosée, marge, statut OK/à surveiller/risque moisissure/condensation). Inclut la météo extérieure courante.

### `GET /comfort/simulate?t_int=&rh=&t_ext=`

What-if : renvoie l'évaluation pour des valeurs arbitraires. Utilisé par le simulateur du frontend.

---

## Weather

### `GET /weather/current`

Météo extérieure courante (Bruxelles par défaut). Source Open-Meteo, cache mémoire 1h.

### `GET /weather/history?from=YYYY-MM-DD&to=YYYY-MM-DD&interval=hourly|daily`

Archive Open-Meteo (ERA5). Latence ~2 jours. Renvoie la série brute (temps, T°, humidité, vent, précipitations).

### `GET /weather/co2_atmospheric`

Concentration globale de CO₂ (Mauna Loa NOAA via global-warming.org). Inclut le taux annuel d'augmentation et la projection en années jusqu'au seuil 450 ppm des accords de Paris. Cache 24h.

---

## Pipe sensors (chaudière / ECS)

### `GET /pipe/sensors`

Liste des sondes DS18B20 enregistrées.

### `POST /pipe/sensors`

Enregistre une sonde. Body :

```json
{
  "name": "Depart chaudiere",
  "kind": "boiler_out",     // boiler_out | boiler_return | dhw_tank | radiator
  "shelly_ip": "192.168.1.50",
  "shelly_channel": 100,
  "baseline_c": 30,
  "color": "#ef4444"
}
```

### `PUT /pipe/sensors/:id`, `DELETE /pipe/sensors/:id`

Mise à jour / suppression.

### `GET /pipe/readings/:id?from=ISO&to=ISO`

Série brute de température pour cette sonde (24h par défaut).

### `GET /pipe/cycles/:id?from=ISO&to=ISO`

Cycles détectés sans les heuristiques, pour outils tiers.

### `GET /pipe/analysis/:id?from=ISO&to=ISO`

Analyse complète. Branche par `sensor.kind` :

- **Chaudière** (`boiler_out`, `radiator`, `boiler_return`) : cycles détectés + heuristiques de **surchauffe** (cycle démarré alors qu'une pièce ≥22°C) et **sous-dimensionnement** (score 0-100 à partir de la fréquence et durée des cycles) + diagnostic textuel.
- **ECS** (`dhw_tank`) : recharges détectées + **soutirages** (chutes brutales) + **pertes au repos** (°C/h pendant les intervalles entre cycles) + diagnostic spécifique cuve.

```json
{
  "from": "2026-05-13T...",
  "to": "2026-05-14T...",
  "sensor": { "id": "...", "name": "...", "kind": "boiler_out", "color": "..." },
  "sample_count": 4321,
  "cycles": [{ "start_ts", "end_ts", "peak_ts", "base_c", "peak_c", "delta_c", "rise_duration_min", "total_duration_min" }, ...],
  "analysis": {
    "cycles_count": 12,
    "avg_duration_min": 14.2,
    "avg_peak_c": 62.4,
    "cycles_per_hour": 0.5,
    "overheating_events": 0,
    "undersizing_score": 22,
    "diagnosis": ["...", "..."]
  }
}
```

---

## Report

### `GET /report?campaign_id=...`

Rapport JSON de fin de campagne (KPIs cumulés, comparaisons mois/mois, etc.).

---

## Export

### `GET /export/zip?campaign_id=...`

ZIP archive contenant les CSV des lectures, le rapport JSON, un README explicatif. Pour archivage citoyen ou analyse offline.

---

## Health

### `GET /health` (public, pas d'auth)

`{ "status": "ok", "campaign": {...}, "ts": "..." }`. Utile pour les checks externes.

---

## Codes d'erreur courants

| Code | Cause |
|---|---|
| 400 | Body manquant ou invalide |
| 401 | Pas connecté ou cookie expiré |
| 403 | Pas admin / pas la bonne campagne |
| 404 | Ressource introuvable (ex: capteur d'un autre kit) |
| 502 | Service externe indisponible (Open-Meteo, NOAA, Resend) |
| 500 | Erreur interne (regarder `journalctl -u beaba`) |

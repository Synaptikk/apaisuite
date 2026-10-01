# Auror API recon for `orcmonitor` (2026-09-25)

Read-only probe of `https://app.us.auror.co/api/spa/*` from inside an Auror tab in the
debug Edge. Auth: `Authorization: Bearer <jwt>` (captured from the SPA's own requests)
+ `X-Requested-With: XMLHttpRequest`. Walmart org id = **12**. Every call below was a GET,
except the two POST *query* endpoints the SPA itself uses for reading (marked).
Field names and types only. No personal data is recorded here.

Endpoint list source: the SPA bundle's generated client (`this.fetch("<name>", "api/spa/...")`),
714 distinct paths. Only the ones useful for ORC monitoring are covered here.

---

## 1. GlobalSearch/globalSearch

`GET /api/spa/GlobalSearch/globalSearch?searchString=&skip=0&includeTotalResultCount=true&intelTypeFilters=Event&siteTraits=REGION: 12&timeRangeFilter=Last30days&startDate=&endDate=&isOrganizedRetailCrime=true`

Full param list from the SPA client: `searchString, skip, includeTotalResultCount,
intelTypeFilters, genderFilters, ageGroupFilters, heightRangeFilters, buildFilters,
behaviorFilters, eventTypeFilters, siteTraits, timeRangeFilter, incidentCountMin,
incidentCountMax, totalValueMin, totalValueMax, eventSensitivityReasons, startDate,
endDate, isOrganizedRetailCrime`.

**Paging**
- The page size is fixed at **10**. `take`, `pageSize` and `top` are ignored.
- `skip` is the offset (0, 10, 20…). The last page is short. Example: REGION 12 ORC last 30 days: `totalResultCount` 35, `skip=30` returns 5.
- **Results are NOT sorted by date.** The order is relevance/arbitrary, and pages mix dates. To get the newest events, fetch every page and sort client-side on `occurredAt`.
- Note: the user's feature flag `Core_Search_EnableElastic: true` means the SPA's own search UI now uses `SearchApi/*` (see below). `globalSearch` still works.

**Response**
```
{ searchResults: [ {
    documentKey: "12_e12761074", resourceLocator: "e12761074",   // e<eventId> | p<personId> | v<vehicleId>
    primaryIdentifier: "Third party shopper/delivery theft e1276…",
    eventType: "ThirdPartyAgentTheft", intelType: "Event", conflationKey,
    description: "Walmart 695 - 2232 Gallatin Pike N, Nashville, TN, …",  // site name + address (only site info)
    siteName: null,                       // always null in practice
    occurredAt: "…Z", localOccurredAt: "…", createdAt: "…Z",
    totalValue: number, totalValueInOrgBaseCurrency: {value,currency}, isFullyRecovered: bool,
    eventCount, hasThreateningBehaviors, threateningBehaviors: [], sensitivityReasons: [],
    isPublicVehicleOfInterest, image, matchedValues, isOrganizedRetailCrime: bool } ],
  totalResultCount: number, searchId, searchServiceName, metadata }
```
Results have no site id, no store-number field and no lat/lon. The store number comes
only from `description` (`/^Walmart (\d+) - /`). For coordinates, use EventProfile or siteStats (section 3).

**timeRangeFilter** (SPA enum: `All, Last24Hours, LastWeek, Last7days, Previous7Days, Last30days, ThisMonth, LastMonth, ThisYear, Last12Months, LastYear, Custom`; the search UI offers `All, Last24Hours, Last7days, Last30days, Custom`)

| value | result |
|---|---|
| `Last7days`, `Last30days`, `Last24Hours` | 200 |
| `Last60days`, `Last90days`, `Last6months`, `Last12months`, `LastYear`, `AllTime`, `All`, `Bogus` | **400** (empty body) |
| `Custom` + any startDate/endDate | **400** |
| `""` (empty) + `startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` | **200**. Custom ranges work this way. Both ends are inclusive. `2026-09-23..2026-09-23` returns that one day. |
| `""` + any date that has a time part (`…T00:00:00`, `…Z`, `toISOString()`) | **400** |
| `""` with empty dates | 200, all time (REGION 12 ORC = 1446) |

> **Bug in current `listRegionEvents()`**: for `days` other than 7 or 30 it sends
> `timeRangeFilter=Custom` with `toISOString()` dates. That combination always returns 400. Send
> `timeRangeFilter=""` and `startDate/endDate` as `YYYY-MM-DD`. The function also assumes
> the newest events come first. They don't, so it needs a sort, and `max` truncation drops arbitrary events.

**siteTraits**: the format is `"<TRAIT KEY>: <VALUE>"`, exactly as the strings from
`OrcDashboard/locations` (all uppercase). You can repeat the param, and repeated values are
**OR**ed together (GA 171 + TN 37 = 208 with both). Verified with ORC=true or false, last 30 days:
- `REGION: 12` returns 35 ORC. `WALMART MARKET: 120` returns 0 ORC but 115 in total (it works; market 120 simply had no ORC-tagged events). `WALMART MARKET: 128` returns 208 in total.
- `MARKET: 120` and `DISTRICT: 120` return 0, because they are not real traits.
- `STATE: GEORGIA`, `BUSINESS UNIT: A - SOUTHEAST BU` (615 ORC), `CITY: CHATTANOOGA - TN`, `ORC CORRIDOR: ORC CORRIDOR I-40/75/81 (…)` all work.
- `SITE: WALMART 1458 - 3040 BATTLEFIELD PKWY, FORT OGLETHORPE, GA` works (the exact uppercase string). Mixed case returns 0.
- Omitting siteTraits searches the whole org (2706 ORC events in 30 days).

**isOrganizedRetailCrime**: `true` returns only ORC-tagged events. `false` or omitted returns **no filter** (REGION 12: 1882, mostly non-ORC).
**intelTypeFilters**: `Person` or `Vehicle` combined with `isOrganizedRetailCrime=true` returns **0**, because persons and vehicles never carry the ORC flag. `Person` with ORC=false returns people (`resourceLocator: "p…"`, 3538). To find ORC people, use the ORC dashboard (section 4).
`eventTypeFilters=Shoptheft` narrows by event type (GA ORC 77).

Other trait keys available (from `GET /api/spa/OrcDashboard/locations?orgId=12`, a flat
`string[]` of 12,376 `"KEY: VALUE"` entries; `Insights/12/getLocations` is identical):
`WALMART MARKET` (455), `SITE` (5633), `CITY`, `DISTRICT` (county), `STATE`, `REGION` (47), `BUSINESS UNIT`
(e.g. `A - SOUTHEAST BU`), `ORC CORRIDOR` (56), `ORC DISTRO` (e.g. `ORCGA`), `DIVISION`, `NETWORK`,
`GROUP`, `FACILITY TYPE`, `SAMS CLUB MARKET`, `POLICE DISTRICT`, `SUBURB`, `DC TYPE`, `WALMART DEPOT`,
`WALMART STORES ORG`, `SAMS CLUB ORG`. `DataExplorer/12/locations` returns the same list as
`{siteTraitKey, siteTraitValue}` objects.

**SearchApi (the elastic search the SPA now uses)**
- `GET /api/spa/SearchApi/searchPeople?searchString=&skip=0&includeTotalResultCount=true&timeRangeFilter=Last30days&siteTraits=REGION: 12` returns 20 per page. It has the same row shape as above (`intelType:"Person"`), plus `sortBy`, but no ORC param.
- `GET /api/spa/SearchApi/category/counts?…same filters…` returns `{personCount, vehicleCount, eventCount, siteCount}`.

---

## 2. EventProfile

`GET /api/spa/EventProfile/event/{eventId}` (numeric id, without the `e`)

```
{ eventId, ownerId:"12", isOrganizedRetailCrime: bool, isImported, sourceEventId,
  eventProfileResult: {
    eventPersons: [ { identityGroupId (→ PersonProfile id), gender, ageGroup, heightRange, build,
        dateOfBirth, totalValue, identityGroupPrimaryIdentifier, identityGroupEventCount,
        hasThreateningBehavior, hasEventsInUsersOrganization,
        personEventDetailsFields: [ {systemFieldDefinition, key, value, notes} ],  // no explicit "role"
        trespassInfo: {startDate,endDate}, hasNewTrespass, profileImage } ],
    eventVehicles: [ { identityGroupId (→ vehicle), identityGroupPrimaryIdentifier (plate),
        make, color/vehicleColor, type/vehicleType, totalValue, identityGroupEventCount, … } ],
    eventProducts: [ {name, sku, quantity, price, totalPrice, recovery, category} ],
    eventInternalInfo: {reporterInfoView, witnessesInfoView, reportedOn, additionalDetails},
    policeInformation: {policeReferenceNumber, policeStatus, …}, visibilityInformation, eventCurrency, … },
  eventHeroCardView: {
    eventResourceLocator: "e…", peopleCount, heroCardRunText: [{text,isBold,resourceLocator}],
    location: { resourceLocator: "s4365",          // s<siteId> → SiteDashboard/{siteId}
                description: "Walmart 695 - …",   // store number in the name
                country, latitude, longitude, address },
    zoneOrRoom, totalValue, totalRecoveredValue, eventTotalValue:{value,currency},
    occurredAt (local), occurredAtUtc, eventType, subscriptionTopic, eventImages:[…] },
  evidenceLockerView, personDebtInfo, videoRetrievalRequestInfo, … }
```
- Person roles: there is no role/offender-type field. `personEventDetailsFields` holds
  `PersonEventOutcome` (e.g. Prevented), appearance items and `OperationExiting` / `OperationSurveillance`.
- There is no linked-events, ORC-group or case id on the event. `onlyForInvestigationId` and the image `investigationId` are null unless the event sits inside an investigation.

---

## 3. Sites with lat/lon (the goal): `RegionDashboard/{org}/siteStats`

**Best source.** The market/region intel dashboard's map calls:

`GET /api/spa/RegionDashboard/12/siteStats?rangeStart=2020-01-01&rangeEnd=2026-09-25&region=<TRAIT>`

- `region` is `KEY:VALUE`, URL-encoded. `WALMART MARKET:120`, `WALMART MARKET: 120`, `REGION:12`, `BUSINESS UNIT:A - SOUTHEAST BU` and `STATE:GEORGIA` all work.
- The response is a **plain unpaged array**:
  `[{ siteId:"6805", siteName:"Walmart 3660 - 3550 Cummings Hwy, Chattanooga, TN", siteLatitude, siteLongitude, eventCount, totalValueMoney:{value,currency}, recoveredPercentage }]`
- It only includes sites with ≥1 event in the range. Use a wide range for full coverage:

| region | `RegionDashboard/12/profile?region=…` siteCount | siteStats rows (range) |
|---|---|---|
| WALMART MARKET:120 | 10 | 9 (30 d), 10 (1 y) |
| REGION:12 | 111 | 111 (1 y), 111 (since 2020) |
| BUSINESS UNIT:A - SOUTHEAST BU | 802 | 799 (1 y), 801 (since 2020) |
| STATE:GEORGIA | – | 223 (154 are `Walmart ####`; the rest are Sam's, DCs and similar) |

- The store number is parsed from `siteName` (`/^Walmart (\d+) - /`). `siteId` is Auror's site id, the same id as `s<siteId>` in event/person locators and in `OrcDashboard.lastActiveAtSiteId`.
- Region profile: `GET /api/spa/RegionDashboard/12/profile?region=WALMART%20MARKET%3A120` returns `{regionName, siteCount, snowflakeLastSynced, …}`. It is useful as a completeness check. Data syncs from Snowflake, and `snowflakeLastSynced` was ~09:40 UTC the same day.
- `RegionDashboard/12/topSites?region=…&rangeStart&rangeEnd&skip=0&take=15&sortSitesBy=EventCount` returns `{skip,take,sites:[{siteId,siteName,organizationName,eventCount,totalValueMoney,recoveredPercentage}]}`, with no lat/lon.

Other site endpoints, which have no lat/lon:
- `GET /api/spa/SiteDashboard/{siteId}/profile` returns `{siteName, siteLocatorToken:"s4365", sitePrimaryIdentifier:"695" (the store number), siteAddress:{streetNumber,streetName,city,state,postCode,country,…}, siteTraits:[{key,value}] (STATE, DISTRICT, REGION, CITY, BUSINESS UNIT, FACILITY TYPE, SITE, ORC CORRIDOR, ORC DISTRO, WALMART MARKET, WALMART STORES ORG), sitePrimaryPhone, snowflakeLastSynced}`. **This is the way to get a site's market and region from its siteId.**
- `GET /api/spa/Sites/organizations/12/searchable-sites?search=<text>` returns `{items:[{id, name, primaryIdentifier (store #)}], lastItemToken, hasNextPage}`. It is fixed at 25, it is a prefix search, and it cannot page (the token is ignored).
- `GET /api/spa/Sites/organizations/12/assigned-sites` returns only the user's assigned site(s). `GET /api/spa/Sites/organizations/12?pageSize=…` returns 403. `auroradmin/SiteManagement/organization/12/sites` returns 404.
- Per event: `EventProfile.eventHeroCardView.location.{latitude,longitude}`. Per person: `personLocationCardView.eventsPerMarker` (section 5).
- `Geo/geo/location?addressQuery=&region=&includeViewport=` is a geocoder. It was not needed, given siteStats.

---

## 4. ORC groups / crews / cases

**ORC dashboard (the SPA's "ORC insights"), the closest thing to a crew list.** POST, read-only query:

`POST /api/spa/OrcDashboard/12/query` (JSON)
```
{ "siteTraitDisplayValues": ["REGION: 12"],       // same "KEY: VALUE" strings; OR'd
  "rangeStart": "2026-08-27", "rangeEnd": "2026-09-25",
  "withOrcTag": true,          // true = people on ORC-tagged events; false = everyone (13,618 in 6 mo)
  "repeatPerson": null,        // true = repeat people only
  "sortBy": "LastActive",      // LastActive | TotalValue | TotalLoss | TotalEvents
  "totalLoss": null,           // or [min,max], e.g. [240,150000]
  "accompliceCount": null, "eventCount": null, "storeCount": null, "vehicleCount": null,
  "totalValue": null, "topPeopleByLossPercentage": null,
  "behaviors": [], "eventTypes": [], "policeAreas": null,
  "cachedTotalCount": null, "page": 0, "loadLastSynced": true }
```
The response: `{ lastSynced, totalCount, canLoadMore, orcCandidates: [ { resourceLocator (personId),
name, profileImageUri, totalValue:{value,currency}, totalLoss:{…}, lastActiveAtSiteId,
lastActiveAtSiteName, lastActiveAtLocationAddressInfo:{streetNumber,streetName,city,state,…},
lastActiveAt, lastActiveDateTime, totalEvents, totalEventsReportedToPolice,
accomplices:{ accompliceInfos:[{resourceLocator (personId), name, isKnown, profileImageUri}],
totalCount, totalKnown, totalUnknown }, behaviors:{<name>:count} } ] }`
- There are **50 per page**, and `page` is 0-based. REGION 12 with ORC tag over 30 days gave 35 rows on a single page.
- `accomplices.accompliceInfos[].resourceLocator` are person ids. This is the crew edge list.
- Related: `GET /api/spa/OrcDashboard/filters` returns the user's saved view `{search:"?l=…&lo=…"}`. That is per-user persisted state. **Don't POST `OrcDashboard/filters`**, because it overwrites the user's own dashboard view. `OrcDashboard/12/organizationInfo` returns `{hasOrcTagEnabled, …}`.

**Investigations (= cases)**: these are user-scoped (`canViewAllInvestigationsForOrg: false` for this user).
- `POST /api/spa/Investigation/investigations/list?page=1` with body `{"investigationStatuses":["Open","InReview","Parked"],"investigationFilter":"UserInvestigations"|"OrganizationInvestigations"|"ArchivedInvestigations","investigationType":null,"leadInvestigatorName":null,"sortBy":"Date","sortDirection":"Descending"}` returns `{myInvestigations:[{id,name,type (OrganizedRetailCrime|InternalLoss|ExternalLoss|…),leadInvestigatorNames,collaboratorCount,startDate,createdAt,status,totalValueForMoney}], orgInvestigations, myInvestigationCount, orgInvestigationCount, statusFilterBreakdown, orgInvestigationTypes, …}`. All of this user's investigations are Internal or External loss, with no ORC-type case.
- `GET /Investigation/{id}/summary` returns `{totalValueForMoney,totalEvents,involvedOrganizations}`.
- `GET /Investigation/{id}/summary/people|locations|vehicles?token=&pageSize=` returns `{items,firstItemToken,lastItemToken,hasNextPage}`.
- `GET /Investigation/{id}/clustered-graph` returns `{nodes:[{id:"p…",label,investigationNodeType,totalEventCount,…}], edges:[…]}`. This is the link graph, and it exists only inside an investigation.
- `GET /Investigation/investigations/stats` returns the user's counts.

**PersonProfile.associatedPersons**: `[{id, identityGroupPrimaryIdentifier, eventCount, profileImage}]`.
`id` is a person identity-group id, and `GET /PersonProfile/person/{id}` works with it (verified 200).
This is "people seen on the same events". `associatedVehicles` has the same shape (`id` → vehicle,
identifier = plate). `knownConnections: {knownConnectionViews:[], canManageKnownConnections}` holds
analyst-entered links. It was empty on the sample, and `GET /PersonProfile/person/{id}/knownConnections` exists.

---

## 5. PersonProfile and ProfileFeed details

`GET /api/spa/PersonProfile/person/{personId}` top-level keys:
`heroCardView, hideProfileFeed, appearanceCardView, personDetailsCardView, locationCount,
personLocationCardView, trespasses, heatmapData, eventTypeCount, productCount, currencyCount,
associatedPersons, associatedVehicles, knownConnections, investigationId, isInvestigateOnlyEntity,
personSiteTrespasses`.
- `heroCardView`: `entityIdentityGroupId, lastActivity, countOfEventsInLast28Days, totalCountOfEvents, countOfEventsAtOrganization, totalMoneyValue{value,currency}, behaviorCounts[{description,count,mostRecentOccurrence}], behaviourEventItems[{eventId,eventType,totalValue,occurredAtUtc,seriousBehaviours,eventPoliceStatus}]`, plus names and images.
- `personLocationCardView.eventsPerMarker[]`: `{ name: "Walmart 1101 - 4538 US-231, Wetumpka, AL", eventCount, latitude, longitude, formattedAddress, resourceLocator: "s4728", investigationId }`. The format is `"Walmart <store#> - <street>, <city>, <ST>"`. There is one marker per site.
- `GET /PersonProfile/person/{personId}/resource/s{siteId}/events?nextPageToken=` returns `{events:[{eventId,eventType,eventTotalValue,occurredAt,investigationId,isExternal}], nextPageToken}`. These are the person's events at one site.
- `locationCount[]`: `{key, value, count}` for trait keys BUSINESS UNIT, FACILITY TYPE, ORC CORRIDOR, ORC DISTRO, ORGANIZATION, REGION, SITE, WALMART MARKET, WALMART STORES ORG. This gives each person's events per market, region or corridor without extra calls.
- `heatmapData`: `{"<dayOfWeek>_<hour>": count}`. `eventTypeCount`: `{<EventType>: n}`. `productCount`: `{<category>: n}`.
- `trespasses[]`: `{organizationName, siteName, startDate, endDate}`.

`GET /api/spa/ProfileFeed/p{personId}?filter=All&nextPageToken=&rangeStart=&rangeEnd=`
- `filter`: `All` returns every type. `Events` returns only EventCreated (all 33 on one page for a 33-event person). `Comments` returns only CommentCreated.
- Paging: the response has `nextPageToken` (e.g. `"639225267969400000_73128460"`). Pass it back as `nextPageToken`. The first page returned 51 groups. `rangeStart` and `rangeEnd` (YYYY-MM-DD) filter the feed.
- Response: `{groups:[{groupToken, items:[item]}], nextPageToken, subscriptionTopicFollowTypes, removableCommentIds, eventsFromUserOrganizationIds:["e…"]}`
- The item is `{id, activityType, title, createdAt, userResponsibleForActivity, activityTriggeredByOrgId, objectId ("e<eventId>" / "p<personId>"), propsBag, localizablePropsBag, text[], primarySubscriptionTopic, fileRepresentation, investigationId, investigationName, dotsConnectedMergeRecords}`.
- `propsBag` keys (all values are **strings**, e.g. `"$1,896.00"`, `"False"`, `"null"`, JSON-encoded arrays):
  - **EventCreated**: `EventType, SiteName, TotalValue, TotalRecoveredValue, TotalToPay, OccurredAt (UTC Z), LocalOccurredAt, IsReportedToPolice, ProductCategories, EventProductCategoryCount, SiteSuburb, SiteCity, PersonCount, HasCivilRecoveriesEnabled, LicensePlates, ReasonsEventIsSensitive, CurrentEventVersion, PoliceStatus, PrimaryIdentifier`
  - **PersonDotsConnected** (profile merges): `PrimaryIdentifier, EventCount, TotalValue, ProfileMergeCount, EntityGroupingOperationId, FoundByAurorIntelligence, WinnerGroupOriginalPrimaryIdentifier, WinnerGroupOriginalProfileImageClientId, RedactedActivityTitle`
  - **CommentCreated**: `CommentTitle, CommentCreatedAt, CommentCreatedBy, CommentorJobTitle`
- `localizablePropsBag` (typed) for EventCreated: `type, eventType, siteName (full, e.g. "Walmart 1205 - …, FL"), totalValue{value,currency}, totalRecoveredValue, localOccurredAt, isReportedToPolice (bool), productCategories[], aurorProductCategories[], reasonsEventIsSensitive[], policeStatus, previousPoliceStatus, reportedToEmail, eventToken ("e<eventId>")`.
- **The feed items have no site id or site number field.** The store number comes only from the `SiteName` prefix. `eventToken`/`objectId` gives the event id, and EventProfile gives `location.resourceLocator` (the site id) and lat/lon.

---

## Recommended data path for orcmonitor

1. The **store map** comes from `RegionDashboard/12/siteStats?region=BUSINESS UNIT:A - SOUTHEAST BU&rangeStart=2020-01-01&rangeEnd=<today>`. That is one call for ~800 SE sites with siteId, name (store #) and lat/lon. Cache it for days, and use per-REGION/MARKET calls if the scope is smaller.
2. **ORC events** come from globalSearch with `isOrganizedRetailCrime=true`, one or more `siteTraits`, and either `timeRangeFilter=Last7days|Last30days` or `timeRangeFilter=` plus `startDate/endDate=YYYY-MM-DD`. Page with `skip` += 10 until `totalResultCount`, then sort client-side. Join each event to its store with the `description` prefix store number.
3. **ORC people and crews** come from `POST OrcDashboard/12/query` (50/page, with `lastActiveAtSiteId` and accomplice person ids). That replaces the event→EventProfile→person fan-out.
4. Per-person detail comes from PersonProfile (eventsPerMarker lat/lon, locationCount, associatedPersons) and ProfileFeed `filter=Events`.

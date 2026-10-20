# HopConvert

Free, client-side tools for converting JSON, CSV, XML, and YAML — built for developers, analysts, and data teams who care about speed and privacy.

## Converters

- [JSON to CSV](index.html)
- [CSV to JSON](csv-to-json.html)
- [XML to CSV](xml-to-csv.html)
- [JSON to YAML](json-to-yaml.html)
- [YAML to JSON](yaml-to-json.html)

## Guides

- [JSON to CSV guide](json-to-csv-guide.html)
- [CSV to JSON guide](csv-to-json-guide.html)
- [XML to CSV guide](xml-to-csv-guide.html)
- [JSON to YAML guide](json-to-yaml-guide.html)
- [YAML to JSON guide](yaml-to-json-guide.html)

## How it works

Every converter is a self-contained static HTML page. All parsing, flattening, escaping, and serialization happens in your browser using JavaScript — there is no backend, no upload, no account.

- 100% free, no sign-up, no Pro tier
- Files never leave your machine
- RFC 4180 compliant CSV
- YAML 1.2 compatible
- Mobile-friendly with a touch dropdown nav

## Tech

Plain HTML + CSS + vanilla JS. No build step. No CDNs required for any converter except `yaml-to-json.html` (which loads js-yaml from a CDN for the reference parser). Every page is a deployable static file.

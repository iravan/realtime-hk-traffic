declare namespace GeoJSON {
  type Position = number[];
  interface GeoJsonObject {
    type: string;
  }
  interface Point extends GeoJsonObject {
    type: "Point";
    coordinates: Position;
  }
  interface Feature<G = GeoJsonObject, P = Record<string, unknown> | null> extends GeoJsonObject {
    type: "Feature";
    geometry: G;
    properties: P;
  }
  interface FeatureCollection<G = GeoJsonObject, P = Record<string, unknown> | null> extends GeoJsonObject {
    type: "FeatureCollection";
    features: Array<Feature<G, P>>;
  }
  type GeoJSON = GeoJsonObject | Feature | FeatureCollection;
}

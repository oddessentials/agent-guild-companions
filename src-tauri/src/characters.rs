//! Characters people add from Agent Guild: World piece folders. The structural checks and their limits
//! are agent-guild's src/manager/yard-piece-check.mjs (checkJson, checkImages); the page draws each one
//! with the Yard's model checks before it is installed (web/characters.js).

use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};

pub const MODEL: &str = "character.glb";
const MANIFEST: &str = "piece.json";
const INSTALL: &str = "install.json";
const STAGING: &str = ".staging-";
const REMOVED: &str = ".removed-";
const CHECK: &str = "check-";
const MAX_MANIFEST: u64 = 16 * 1024;
const MAX_MODEL: u64 = 128 * 1024 * 1024;
const MAX_FACES: u64 = 210_000;
const MAX_SIDE: u64 = 4096;
const MAX_JSON: usize = 1024 * 1024;
const MAX_PARTS: u64 = 16;
const COUNTS: [(&str, usize); 11] = [
    ("nodes", 256), ("meshes", 16), ("materials", 16), ("textures", 16), ("samplers", 16), ("images", 8),
    ("animations", 16), ("accessors", 2048), ("bufferViews", 2048), ("skins", 2), ("buffers", 1),
];
const REQUIRED_OK: [&str; 4] = ["EXT_texture_webp", "KHR_texture_transform", "KHR_materials_emissive_strength", "KHR_mesh_quantization"];
const IMAGE_TYPES: [&str; 3] = ["image/png", "image/jpeg", "image/webp"];
const MATERIAL_TEXTURES: [(&str, &[&str]); 9] = [
    ("KHR_materials_clearcoat", &["clearcoatTexture", "clearcoatRoughnessTexture", "clearcoatNormalTexture"]),
    ("KHR_materials_diffuse_roughness", &["diffuseRoughnessTexture"]),
    ("KHR_materials_sheen", &["sheenColorTexture", "sheenRoughnessTexture"]),
    ("KHR_materials_specular", &["specularTexture", "specularColorTexture"]),
    ("KHR_materials_transmission", &["transmissionTexture"]),
    ("KHR_materials_iridescence", &["iridescenceTexture", "iridescenceThicknessTexture"]),
    ("KHR_materials_anisotropy", &["anisotropyTexture"]),
    ("KHR_materials_volume", &["thicknessTexture"]),
    ("EXT_materials_bump", &["bumpTexture"]),
];
const METADATA: [&str; 2] = ["name", "extras"];
const PROPERTIES: [(&str, &[&str]); 10] = [
    ("accessor", &["bufferView", "byteOffset", "componentType", "normalized", "count", "type", "max", "min", "sparse"]),
    ("bufferView", &["buffer", "byteOffset", "byteLength", "byteStride", "target"]),
    ("skin", &["inverseBindMatrices", "skeleton", "joints"]),
    ("node", &["children", "skin", "matrix", "mesh", "rotation", "scale", "translation", "extensions"]),
    ("mesh", &["primitives"]),
    ("primitive", &["attributes", "indices", "material", "mode", "targets"]),
    ("animation", &["channels", "samplers"]),
    ("sampler", &["input", "interpolation", "output"]),
    ("channel", &["sampler", "target"]),
    ("target", &["node", "path"]),
];
const FLOAT: (u64, bool) = (5126, false);
const S_BYTE: (u64, bool) = (5120, false);
const S_NBYTE: (u64, bool) = (5120, true);
const S_SHORT: (u64, bool) = (5122, false);
const S_NSHORT: (u64, bool) = (5122, true);
const U_BYTE: (u64, bool) = (5121, false);
const U_NBYTE: (u64, bool) = (5121, true);
const U_SHORT: (u64, bool) = (5123, false);
const U_NSHORT: (u64, bool) = (5123, true);
const U_INT: (u64, bool) = (5125, false);

type Checked<T = ()> = Result<T, String>;

fn bad(message: &str) -> String {
    format!("{MODEL} {message}")
}

#[derive(Clone, Debug, PartialEq)]
pub struct Character {
    pub id: String,
    pub title: String,
    pub readable: bool,
}

pub fn read_manifest(bytes: &[u8]) -> Checked<String> {
    let unreadable = || "This piece’s details can’t be read.".to_string();
    let meta: Value = serde_json::from_slice(bytes).map_err(|_| unreadable())?;
    let meta = meta.as_object().ok_or_else(unreadable)?;
    match meta.get("format").and_then(int) {
        Some(1) => {}
        Some(n) if n > 1 => return Err("This piece needs a newer Agent Guild.".into()),
        _ => return Err("This piece’s format is missing.".into()),
    }
    match meta.get("kind").and_then(Value::as_str) {
        Some("character") => {}
        Some("companion") => return Err("This is a companion piece, not a character.".into()),
        _ => return Err("This isn’t a character or companion piece.".into()),
    }
    match meta.get("title") {
        None => Ok(String::new()),
        Some(Value::String(title)) if title.encode_utf16().count() <= 128 && !title.chars().any(char::is_control) => Ok(title.trim().to_string()),
        Some(_) => Err("This piece’s title is too long or unreadable.".into()),
    }
}

fn int(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_f64().filter(|f| f.fract() == 0.0 && f.abs() <= 9007199254740991.0).map(|f| f as i64))
}

fn length(value: Option<&Value>) -> Option<u64> {
    value.and_then(int).filter(|n| *n >= 0).map(|n| n as u64)
}

fn index(value: Option<&Value>, len: usize) -> Option<usize> {
    length(value).map(|n| n as usize).filter(|n| *n < len)
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn read_glb(b: &[u8]) -> Checked<(Value, usize, usize)> {
    let not_glb = || bad("isn’t a binary glTF model.");
    if b.len() < 20 || &b[0..4] != b"glTF" || u32_at(b, 4) != 2 || u32_at(b, 8) as usize != b.len() {
        return Err(not_glb());
    }
    let size = u32_at(b, 12) as usize;
    if u32_at(b, 16) != 0x4e4f534a || size > MAX_JSON || 20 + size > b.len() {
        return Err(not_glb());
    }
    let json: Value = serde_json::from_slice(&b[20..20 + size]).map_err(|_| not_glb())?;
    let at = 20 + size;
    if at + 8 > b.len() {
        return Ok((json, at + 8, 0));
    }
    let bin = u32_at(b, at) as usize;
    if u32_at(b, at + 4) != 0x004e4942 || at + 8 + bin > b.len() {
        return Err(not_glb());
    }
    Ok((json, at + 8, bin))
}

fn list<'a>(json: &'a Value, key: &str) -> Checked<&'a [Value]> {
    match json.get(key) {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(bad("is damaged and can’t be drawn.")),
    }
}

fn elements(kind: &str) -> u64 {
    match kind {
        "SCALAR" => 1,
        "VEC2" => 2,
        "VEC3" => 3,
        "VEC4" | "MAT2" => 4,
        "MAT3" => 9,
        "MAT4" => 16,
        _ => 0,
    }
}

fn component_bytes(kind: u64) -> u64 {
    match kind {
        5120 | 5121 => 1,
        5122 | 5123 => 2,
        5125 | 5126 => 4,
        _ => 0,
    }
}

fn attribute_forms(semantic: &str, quantized: bool) -> Option<(&'static [&'static str], Vec<(u64, bool)>)> {
    let (types, mut forms, extra): (&[&str], Vec<(u64, bool)>, &[(u64, bool)]) = match semantic {
        "POSITION" => (&["VEC3"], vec![FLOAT], &[S_BYTE, S_NBYTE, U_BYTE, U_NBYTE, S_SHORT, S_NSHORT, U_SHORT, U_NSHORT]),
        "NORMAL" => (&["VEC3"], vec![FLOAT], &[S_NBYTE, S_NSHORT]),
        "TANGENT" => (&["VEC4"], vec![FLOAT], &[S_NBYTE, S_NSHORT]),
        "TEXCOORD" => (&["VEC2"], vec![FLOAT, U_NBYTE, U_NSHORT], &[S_BYTE, S_NBYTE, U_BYTE, S_SHORT, S_NSHORT, U_SHORT]),
        "COLOR" => (&["VEC3", "VEC4"], vec![FLOAT, U_NBYTE, U_NSHORT], &[]),
        "JOINTS" => (&["VEC4"], vec![U_BYTE, U_SHORT], &[]),
        "WEIGHTS" => (&["VEC4"], vec![FLOAT, U_NBYTE, U_NSHORT], &[]),
        _ => return None,
    };
    if quantized {
        forms.extend_from_slice(extra);
    }
    Some((types, forms))
}

fn attribute_name(key: &str) -> Option<&str> {
    if matches!(key, "POSITION" | "NORMAL" | "TANGENT") {
        return Some(key);
    }
    let (semantic, set) = key.rsplit_once('_')?;
    (matches!(semantic, "TEXCOORD" | "COLOR" | "JOINTS" | "WEIGHTS") && !set.is_empty() && set.bytes().all(|c| c.is_ascii_digit())).then_some(semantic)
}

fn unit_quaternion(values: &[Value]) -> bool {
    let parts: Vec<f64> = values.iter().filter_map(Value::as_f64).collect();
    parts.len() == 4 && (parts.iter().map(|v| v * v).sum::<f64>().sqrt() - 1.0).abs() <= 0.001
}

fn allowed(kind: &str, object: &Value) -> Checked {
    let object = object.as_object().ok_or_else(|| bad(&format!("has a {kind} that can’t be read.")))?;
    let known = PROPERTIES.iter().find(|(name, _)| *name == kind).map(|(_, keys)| *keys);
    let extra = object.keys().find(|key| match known {
        Some(keys) => !keys.contains(&key.as_str()) && !METADATA.contains(&key.as_str()),
        None => attribute_name(key).is_none(),
    });
    match extra {
        Some(key) => Err(bad(&format!("uses a glTF property the Yard doesn’t read ({kind}.{key})."))),
        None => Ok(()),
    }
}

fn check_json(json: &Value, bin: usize) -> Checked {
    if !json.is_object() {
        return Err(bad("isn’t a binary glTF model."));
    }
    for (key, most) in COUNTS {
        match json.get(key) {
            None => {}
            Some(Value::Array(items)) if items.len() <= most => {}
            _ => return Err(bad(&format!("has more {key} than a piece may."))),
        }
    }
    for extension in list(json, "extensionsRequired")? {
        let name = extension.as_str().unwrap_or_default();
        if !REQUIRED_OK.contains(&name) {
            return Err(bad(&format!("needs {name}, which the Yard can’t draw.")));
        }
    }
    let outside = || bad("refers to files outside itself.");
    if list(json, "buffers")?.iter().any(|buffer| buffer.get("uri").is_some()) {
        return Err(outside());
    }
    for image in list(json, "images")? {
        if image.get("uri").is_some() || image.get("bufferView").is_none() {
            return Err(outside());
        }
        if !IMAGE_TYPES.contains(&image.get("mimeType").and_then(Value::as_str).unwrap_or_default()) {
            return Err(bad("has an image the Yard can’t draw."));
        }
    }
    let accessors = list(json, "accessors")?;
    if accessors.iter().any(|accessor| accessor.get("sparse").is_some_and(|sparse| !sparse.is_null() && sparse != &Value::Bool(false))) {
        return Err(bad("uses sparse data, which a piece may not."));
    }
    for material in list(json, "materials")? {
        let pbr = material.get("pbrMetallicRoughness");
        let mut infos: Vec<Option<&Value>> = vec![
            pbr.and_then(|p| p.get("baseColorTexture")),
            pbr.and_then(|p| p.get("metallicRoughnessTexture")),
            material.get("normalTexture"),
            material.get("occlusionTexture"),
            material.get("emissiveTexture"),
        ];
        for (extension, slots) in MATERIAL_TEXTURES {
            for slot in slots {
                infos.push(material.pointer(&format!("/extensions/{extension}/{slot}")));
            }
        }
        for info in infos.into_iter().flatten().filter(|info| !info.is_null()) {
            for channel in [info.get("texCoord"), info.pointer("/extensions/KHR_texture_transform/texCoord")] {
                let ok = match channel {
                    None => true,
                    Some(value) => int(value).is_some_and(|n| (0..=3).contains(&n)),
                };
                if !ok {
                    return Err(bad(&format!("uses texture channel {}, which the Yard can’t draw.", channel.unwrap())));
                }
            }
        }
    }
    let views = list(json, "bufferViews")?;
    let nodes = list(json, "nodes")?;
    let meshes = list(json, "meshes")?;
    let skins = list(json, "skins")?;
    let animations = list(json, "animations")?;
    for accessor in accessors {
        allowed("accessor", accessor)?;
    }
    for view in views {
        allowed("bufferView", view)?;
    }
    for skin in skins {
        allowed("skin", skin)?;
    }
    for node in nodes {
        allowed("node", node)?;
    }
    for mesh in meshes {
        allowed("mesh", mesh)?;
        let primitives = mesh.get("primitives").and_then(Value::as_array).ok_or_else(|| bad("has a mesh that can’t be read."))?;
        for primitive in primitives {
            allowed("primitive", primitive)?;
            let attributes = primitive.get("attributes").unwrap_or(&Value::Null);
            allowed("attributes", attributes)?;
            if attributes.get("POSITION").is_none() {
                return Err(bad("has a mesh without positions."));
            }
        }
    }
    for animation in animations {
        allowed("animation", animation)?;
        for sampler in animation.get("samplers").and_then(Value::as_array).into_iter().flatten() {
            allowed("sampler", sampler)?;
        }
        for channel in animation.get("channels").and_then(Value::as_array).into_iter().flatten() {
            allowed("channel", channel)?;
            allowed("target", channel.get("target").unwrap_or(&Value::Null))?;
        }
    }
    let missing = || bad("refers to data it doesn’t contain.");
    let multiplied = || bad("reuses its data in a way that would multiply its size.");
    let bin = bin as u64;
    let mut view_bytes = 0u64;
    for view in views {
        let offset = if view.get("byteOffset").is_some() { length(view.get("byteOffset")) } else { Some(0) };
        let (Some(0), Some(size), Some(offset)) = (length(view.get("buffer")), length(view.get("byteLength")), offset) else { return Err(missing()) };
        if offset + size > bin {
            return Err(missing());
        }
        view_bytes += size;
    }
    if view_bytes > bin {
        return Err(multiplied());
    }
    let mut accessor_bytes = 0u64;
    for accessor in accessors {
        let width = elements(accessor.get("type").and_then(Value::as_str).unwrap_or_default()) * component_bytes(length(accessor.get("componentType")).unwrap_or(0));
        let offset_ok = accessor.get("byteOffset").is_none() || length(accessor.get("byteOffset")).is_some();
        let (Some(count), Some(view)) = (length(accessor.get("count")), index(accessor.get("bufferView"), views.len())) else { return Err(missing()) };
        if width == 0 || !offset_ok {
            return Err(missing());
        }
        if let Some(stride) = views[view].get("byteStride") {
            if length(Some(stride)) != Some(width) {
                return Err(bad("interleaves its data, which a piece may not."));
            }
        }
        accessor_bytes += count * width;
    }
    if accessor_bytes > bin {
        return Err(multiplied());
    }
    let quantized = list(json, "extensionsUsed")?.iter().any(|e| e.as_str() == Some("KHR_mesh_quantization"));
    let drawable = |at: usize, types: &[&str], forms: &[(u64, bool)]| {
        let accessor = &accessors[at];
        let kind = accessor.get("type").and_then(Value::as_str).unwrap_or_default();
        let component = length(accessor.get("componentType")).unwrap_or(0);
        let normalized = accessor.get("normalized").is_some_and(|n| n.as_bool().unwrap_or(!n.is_null()));
        types.contains(&kind) && forms.contains(&(component, normalized))
    };
    let count_of = |at: usize| length(accessors[at].get("count")).unwrap_or(0);
    for mesh in meshes {
        for primitive in mesh["primitives"].as_array().into_iter().flatten() {
            let attributes = primitive["attributes"].as_object().into_iter().flatten();
            for (attribute, at) in attributes.clone() {
                let (types, forms) = attribute_forms(attribute_name(attribute).unwrap_or_default(), quantized).unwrap_or((&[], vec![]));
                if let Some(at) = index(Some(at), accessors.len()) {
                    if !drawable(at, types, &forms) {
                        return Err(bad(&format!("has a {attribute} attribute of a type the Yard can’t draw.")));
                    }
                }
            }
            if let Some(at) = index(primitive.get("indices"), accessors.len()) {
                if !drawable(at, &["SCALAR"], &[U_BYTE, U_SHORT, U_INT]) {
                    return Err(bad("has triangle indices of a type the Yard can’t draw."));
                }
            }
            let vertices = index(primitive["attributes"].get("POSITION"), accessors.len()).map(count_of);
            if !attributes.clone().all(|(_, at)| index(Some(at), accessors.len()).is_some_and(|at| Some(count_of(at)) == vertices)) {
                return Err(bad("has a mesh whose attributes don’t share one vertex count."));
            }
            if primitive.get("indices").is_some() && !index(primitive.get("indices"), accessors.len()).is_some_and(|at| count_of(at) % 3 == 0) {
                return Err(bad("has a mesh whose triangles can’t be read."));
            }
        }
    }
    if meshes.iter().any(|mesh| mesh["primitives"].as_array().into_iter().flatten().any(|p| p.get("targets").is_some())) {
        return Err(bad("has shape keys, which the Yard doesn’t use."));
    }
    let mut channels = 0usize;
    for animation in animations {
        let unreadable = || bad("has an animation that can’t be read.");
        let (Some(list), Some(samplers)) = (animation.get("channels").and_then(Value::as_array), animation.get("samplers").and_then(Value::as_array)) else { return Err(unreadable()) };
        if list.len() > 256 {
            return Err(bad("has an animation with more than 256 channels."));
        }
        channels += list.len();
        for channel in list {
            let sampler = index(channel.get("sampler"), samplers.len()).map(|at| &samplers[at]).ok_or_else(unreadable)?;
            let (Some(input), Some(output)) = (index(sampler.get("input"), accessors.len()), index(sampler.get("output"), accessors.len())) else { return Err(unreadable()) };
            if ![input, output].iter().all(|at| length(accessors[*at].get("componentType")) == Some(5126) && !accessors[*at].get("normalized").is_some_and(|n| n.as_bool().unwrap_or(!n.is_null()))) {
                return Err(bad("has animation data that isn’t plain 32-bit floats."));
            }
            let interpolation = sampler.get("interpolation").and_then(Value::as_str).unwrap_or("LINEAR");
            if !matches!(interpolation, "LINEAR" | "STEP") {
                return Err(bad(&format!("uses {interpolation} animation, which the Yard doesn’t play.")));
            }
            let path = match channel["target"].get("path").and_then(Value::as_str) {
                Some("translation") | Some("scale") => "VEC3",
                Some("rotation") => "VEC4",
                _ => "",
            };
            if path.is_empty() || index(channel["target"].get("node"), nodes.len()).is_none() {
                return Err(bad("animates something the Yard doesn’t move."));
            }
            let kind = |at: usize| accessors[at].get("type").and_then(Value::as_str).unwrap_or_default();
            if kind(input) != "SCALAR" || kind(output) != path || count_of(input) < 1 || count_of(output) != count_of(input) {
                return Err(bad("has animation keyframes that don’t match their times."));
            }
        }
    }
    if channels > 2048 {
        return Err(bad("has more than 2,048 animation channels."));
    }
    let scenes = json.get("scenes").and_then(Value::as_array);
    let scene_ok = scenes.is_some_and(|s| s.len() == 1)
        && json.get("scene").map_or(true, |s| int(s) == Some(0))
        && scenes.unwrap()[0].get("nodes").map_or(true, Value::is_array);
    if !scene_ok {
        return Err(bad("needs exactly one scene."));
    }
    let mut parent: Vec<Option<i64>> = vec![None; nodes.len()];
    let mut place = |child: &Value, from: i64| -> Checked {
        let child = index(Some(child), nodes.len()).ok_or_else(|| bad("refers to a node it doesn’t have."))?;
        if parent[child].is_some() {
            return Err(bad("has a node used in two places."));
        }
        parent[child] = Some(from);
        Ok(())
    };
    for root in scenes.unwrap()[0].get("nodes").and_then(Value::as_array).into_iter().flatten() {
        place(root, -1)?;
    }
    for (at, node) in nodes.iter().enumerate() {
        let children = match node.get("children") {
            None => &[][..],
            Some(Value::Array(children)) => children,
            Some(_) => return Err(bad("has a node that can’t be read.")),
        };
        for child in children {
            place(child, at as i64)?;
        }
        if let Some(rotation) = node.get("rotation") {
            if !rotation.as_array().is_some_and(|r| unit_quaternion(r)) {
                let name = node.get("name").and_then(Value::as_str).map_or(at.to_string(), str::to_string);
                return Err(bad(&format!("has a node rotation that isn’t a unit quaternion ({name}).")));
            }
        }
    }
    let mut shown = HashSet::new();
    for at in 0..nodes.len() {
        let mut up = Some(at as i64);
        let mut steps = 0;
        while let Some(node) = up.filter(|n| *n >= 0) {
            if steps > nodes.len() {
                return Err(bad("has nodes that loop."));
            }
            up = parent[node as usize];
            steps += 1;
        }
        if up == Some(-1) {
            shown.insert(at);
        }
    }
    for skin in skins {
        let joints = skin.get("joints").and_then(Value::as_array).filter(|j| j.len() <= 128 && j.iter().all(|joint| index(Some(joint), nodes.len()).is_some()));
        let Some(joints) = joints else { return Err(bad("needs at most 128 joints per skin.")) };
        if skin.get("inverseBindMatrices").is_some() && !index(skin.get("inverseBindMatrices"), accessors.len()).is_some_and(|at| drawable(at, &["MAT4"], &[FLOAT])) {
            return Err(bad("has inverse bind matrices of a type the Yard can’t use."));
        }
        shown.extend(joints.iter().filter_map(|joint| index(Some(joint), nodes.len())));
    }
    for node in nodes {
        if (node.get("mesh").is_some() && index(node.get("mesh"), meshes.len()).is_none()) || (node.get("skin").is_some() && index(node.get("skin"), skins.len()).is_none()) {
            return Err(bad("refers to a part it doesn’t have."));
        }
    }
    let mut extensions: Vec<String> = list(json, "extensionsUsed")?.iter().filter_map(|e| e.as_str().map(str::to_string)).collect();
    extensions.extend(json.get("extensions").and_then(Value::as_object).into_iter().flat_map(|e| e.keys().cloned()));
    extensions.extend(nodes.iter().filter_map(|n| n.get("extensions").and_then(Value::as_object)).flat_map(|e| e.keys().cloned()));
    if extensions.iter().any(|e| e == "KHR_lights_punctual") {
        return Err(bad("uses lights, which a piece may not."));
    }
    if extensions.iter().any(|e| e == "EXT_mesh_gpu_instancing") {
        return Err(bad("uses instancing, which a piece may not."));
    }
    let mut mesh_faces = Vec::with_capacity(meshes.len());
    for mesh in meshes {
        let mut sum = 0;
        for primitive in mesh["primitives"].as_array().into_iter().flatten() {
            if primitive.get("mode").map_or(4, |m| int(m).unwrap_or(-1)) != 4 {
                return Err(bad("has geometry that isn’t triangles."));
            }
            let source = primitive.get("indices").or_else(|| primitive["attributes"].get("POSITION"));
            sum += index(source, accessors.len()).map_or(0, count_of) / 3;
        }
        mesh_faces.push(sum);
    }
    let (mut faces, mut parts) = (0u64, 0u64);
    for (at, node) in nodes.iter().enumerate() {
        let Some(mesh) = index(node.get("mesh"), meshes.len()) else { continue };
        if !shown.contains(&at) {
            continue;
        }
        faces += mesh_faces[mesh];
        let primitives = meshes[mesh]["primitives"].as_array().map_or(&[][..], Vec::as_slice);
        parts += primitives.len() as u64;
        if parts > MAX_PARTS {
            return Err(bad(&format!("draws more than {MAX_PARTS} mesh parts.")));
        }
        if node.get("skin").is_some() && primitives.iter().any(|p| p["attributes"].get("JOINTS_0").is_none() || p["attributes"].get("WEIGHTS_0").is_none()) {
            return Err(bad("has a rigged mesh without weights."));
        }
    }
    if faces > MAX_FACES {
        return Err(bad("has more than 210,000 faces."));
    }
    Ok(())
}

pub fn image_size(b: &[u8]) -> Option<(u64, u64)> {
    let be32 = |at: usize| u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]]) as u64;
    let be16 = |at: usize| u16::from_be_bytes([b[at], b[at + 1]]) as u64;
    let le16 = |at: usize| u16::from_le_bytes([b[at], b[at + 1]]) as u64;
    let le24 = |at: usize| (b[at] as u64) | (b[at + 1] as u64) << 8 | (b[at + 2] as u64) << 16;
    if b.len() >= 24 && be32(0) == 0x89504e47 && &b[12..16] == b"IHDR" {
        return Some((be32(16), be32(20)));
    }
    if b.len() >= 30 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        match &b[12..16] {
            b"VP8 " => return Some((le16(26) & 0x3fff, le16(28) & 0x3fff)),
            b"VP8L" => {
                let v = u32_at(b, 21) as u64;
                return Some(((v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1));
            }
            b"VP8X" => return Some((le24(24) + 1, le24(27) + 1)),
            _ => {}
        }
    }
    if b.len() >= 4 && b[0] == 0xff && b[1] == 0xd8 {
        let mut i = 2;
        while i + 9 < b.len() {
            if b[i] != 0xff {
                return None;
            }
            let marker = b[i + 1];
            if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
                i += 2;
                continue;
            }
            if (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker) {
                return Some((be16(i + 7), be16(i + 5)));
            }
            i += 2 + be16(i + 2) as usize;
        }
    }
    None
}

fn image_spare(kind: &str, data: &[u8]) -> Option<usize> {
    match kind {
        "image/png" => {
            let end = data.windows(4).rposition(|w| w == b"IEND")?;
            data.len().checked_sub(end + 8)
        }
        "image/jpeg" => {
            let end = data.windows(2).rposition(|w| w == [0xff, 0xd9])?;
            Some(data.len() - end - 2)
        }
        "image/webp" if data.len() >= 8 => data.len().checked_sub(u32_at(data, 4) as usize + 8),
        _ => None,
    }
}

fn check_images(json: &Value, b: &[u8], start: usize) -> Checked {
    let damaged = || bad("has an image that is incomplete or damaged.");
    let images = list(json, "images")?;
    let views = list(json, "bufferViews")?;
    let mut bytes = Vec::with_capacity(images.len());
    for image in images {
        let view = index(image.get("bufferView"), views.len()).map(|at| &views[at]).ok_or_else(damaged)?;
        let from = start + length(view.get("byteOffset")).unwrap_or(0) as usize;
        let to = from + length(view.get("byteLength")).unwrap_or(0) as usize;
        if to > b.len() {
            return Err(damaged());
        }
        let data = &b[from..to];
        if !image_spare(image.get("mimeType").and_then(Value::as_str).unwrap_or_default(), data).is_some_and(|spare| spare <= 3) {
            return Err(damaged());
        }
        bytes.push(data);
    }
    let mut drawn = Vec::new();
    for texture in list(json, "textures")? {
        for source in [texture.get("source"), texture.pointer("/extensions/EXT_texture_webp/source")] {
            if let Some(at) = index(source, images.len()) {
                drawn.push(at);
            }
        }
    }
    drawn.sort_unstable();
    drawn.dedup();
    let mut pixels = 0u64;
    for at in drawn {
        let Some((width, height)) = image_size(bytes[at]) else { return Err(bad("has an image that can’t be read.")) };
        if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
            return Err(bad("has a texture larger than 4096 pixels."));
        }
        pixels += width * height;
        if pixels > 4 * MAX_SIDE * MAX_SIDE {
            return Err(format!("{MODEL}’s textures need more memory than a piece may."));
        }
    }
    Ok(())
}

pub fn check_model(b: &[u8]) -> Checked {
    let (json, start, bin) = read_glb(b)?;
    check_json(&json, bin)?;
    check_images(&json, b, start)
}

fn read_source(folder: &Path, name: &str, most: u64) -> Checked<Vec<u8>> {
    let file = folder.join(name);
    let stat = fs::symlink_metadata(&file).map_err(|_| format!("{name} is missing."))?;
    if !stat.is_file() {
        return Err(format!("{name} isn’t a plain file."));
    }
    if stat.len() > most {
        return Err(format!("{name} is larger than a piece may be."));
    }
    let mut bytes = Vec::with_capacity(stat.len() as usize);
    fs::File::open(&file)
        .and_then(|f| f.take(most + 1).read_to_end(&mut bytes))
        .map_err(|_| format!("{name} can’t be read."))?;
    if bytes.len() as u64 > most {
        return Err(format!("{name} is larger than a piece may be."));
    }
    Ok(bytes)
}

pub fn is_id(text: &str) -> bool {
    uuid::Uuid::try_parse(text).is_ok_and(|id| id.hyphenated().to_string() == text)
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().hyphenated().to_string()
}

fn staging(dir: &Path, token: &str) -> PathBuf {
    dir.join(format!("{STAGING}{token}"))
}

pub fn stage(dir: &Path, folder: &Path, token: &str) -> Checked<String> {
    if !fs::metadata(folder).is_ok_and(|m| m.is_dir()) {
        return Err("Choose a piece folder.".into());
    }
    let manifest = read_source(folder, MANIFEST, MAX_MANIFEST)?;
    let title = read_manifest(&manifest)?;
    let title = if title.is_empty() { folder.file_name().map_or("Character".into(), |n| n.to_string_lossy().into_owned()) } else { title };
    let model = read_source(folder, MODEL, MAX_MODEL)?;
    check_model(&model)?;
    let unwritable = |err: io::Error| format!("Grove Companion cannot write to its data folder: {err}");
    let target = staging(dir, token);
    fs::create_dir_all(dir).map_err(unwritable)?;
    let written = fs::create_dir(&target)
        .and_then(|_| fs::write(target.join(MANIFEST), &manifest))
        .and_then(|_| fs::write(target.join(MODEL), &model))
        .and_then(|_| fs::write(target.join(INSTALL), serde_json::json!({ "title": title }).to_string()));
    if let Err(err) = written {
        discard(dir, token);
        return Err(unwritable(err));
    }
    Ok(title)
}

pub fn discard(dir: &Path, token: &str) {
    let _ = fs::remove_dir_all(staging(dir, token));
}

/// Makes a staged piece a character in one rename, so an interruption leaves it staged or installed, never half.
pub fn install(dir: &Path, token: &str) -> io::Result<String> {
    let id = new_id();
    fs::rename(staging(dir, token), dir.join(&id))?;
    Ok(id)
}

pub fn remove(dir: &Path, id: &str) -> io::Result<()> {
    if !is_id(id) || !fs::symlink_metadata(dir.join(id))?.is_dir() {
        return Err(io::ErrorKind::NotFound.into());
    }
    let aside = dir.join(format!("{REMOVED}{id}"));
    fs::rename(dir.join(id), &aside)?;
    let _ = fs::remove_dir_all(aside);
    Ok(())
}

pub fn sweep(dir: &Path) {
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(STAGING) || name.starts_with(REMOVED) {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn installed_title(folder: &Path) -> Option<String> {
    let install: Value = serde_json::from_slice(&fs::read(folder.join(INSTALL)).ok()?).ok()?;
    install.get("title")?.as_str().filter(|title| !title.trim().is_empty()).map(str::to_string)
}

pub fn list_characters(dir: &Path) -> Vec<Character> {
    let mut found: Vec<Character> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let id = entry.file_name().to_str().filter(|name| is_id(name))?.to_string();
            if !entry.file_type().ok()?.is_dir() {
                return None;
            }
            let title = installed_title(&entry.path());
            let readable = title.is_some() && fs::symlink_metadata(entry.path().join(MODEL)).is_ok_and(|m| m.is_file());
            Some(Character { title: title.unwrap_or_else(|| "Unreadable character".into()), readable, id })
        })
        .collect();
    found.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()).then_with(|| a.id.cmp(&b.id)));
    found
}

/// The model a `character://` path names: an installed character's id, or `check-<token>` for the import being checked.
pub fn model_file(dir: &Path, path: &str, checking: Option<&str>) -> Option<PathBuf> {
    let name = path.trim_start_matches('/');
    let folder = match name.strip_prefix(CHECK) {
        Some(token) if checking == Some(token) && is_id(token) => staging(dir, token),
        Some(_) => return None,
        None if is_id(name) => dir.join(name),
        None => return None,
    };
    let file = folder.join(MODEL);
    for part in [&folder, &file] {
        if fs::symlink_metadata(part).ok()?.file_type().is_symlink() {
            return None;
        }
    }
    let root = fs::canonicalize(dir).ok()?;
    let real = fs::canonicalize(&file).ok()?;
    (real.starts_with(&root) && real.is_file()).then_some(file)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &[u8] = include_bytes!("../../tests/fixtures/characters/character.glb");
    const EXTERNAL: &[u8] = include_bytes!("../../tests/fixtures/characters/external_uri.glb");
    const TRUNCATED: &[u8] = include_bytes!("../../tests/fixtures/characters/truncated.glb");
    const TEXTURE_OVER: &[u8] = include_bytes!("../../tests/fixtures/characters/texture_over.glb");
    const MANIFEST_OK: &str = r#"{"format":1,"kind":"character","world":"guild","crew":"anthropic","title":" Patchwork "}"#;

    fn with_json(b: &[u8], change: impl FnOnce(&mut Value)) -> Vec<u8> {
        let (mut json, start, bin) = read_glb(b).unwrap();
        change(&mut json);
        let mut text = serde_json::to_vec(&json).unwrap();
        while text.len() % 4 != 0 {
            text.push(b' ');
        }
        let rest = &b[start - 8..start + bin];
        let mut out = Vec::new();
        out.extend_from_slice(b"glTF");
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&((20 + text.len() + rest.len()) as u32).to_le_bytes());
        out.extend_from_slice(&(text.len() as u32).to_le_bytes());
        out.extend_from_slice(&0x4e4f534au32.to_le_bytes());
        out.extend_from_slice(&text);
        out.extend_from_slice(rest);
        out
    }

    struct Temp(PathBuf);

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    impl std::ops::Deref for Temp {
        type Target = Path;
        fn deref(&self) -> &Path {
            &self.0
        }
    }

    fn folder(name: &str, manifest: &str, model: &[u8]) -> Temp {
        let dir = store(name);
        fs::write(dir.join(MANIFEST), manifest).unwrap();
        fs::write(dir.join(MODEL), model).unwrap();
        dir
    }

    fn store(name: &str) -> Temp {
        let dir = std::env::temp_dir().join(format!("companion-{name}-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        Temp(dir)
    }

    #[test]
    fn a_world_character_passes() {
        assert_eq!(check_model(GOOD), Ok(()));
    }

    #[test]
    fn structural_problems_are_named_as_the_yard_names_them() {
        assert_eq!(check_model(EXTERNAL), Err("character.glb refers to files outside itself.".into()));
        assert_eq!(check_model(TRUNCATED), Err("character.glb isn’t a binary glTF model.".into()));
        assert_eq!(check_model(TEXTURE_OVER), Err("character.glb has a texture larger than 4096 pixels.".into()));
        let ktx = with_json(GOOD, |json| json["extensionsRequired"] = serde_json::json!(["KHR_texture_basisu"]));
        assert_eq!(check_model(&ktx), Err("character.glb needs KHR_texture_basisu, which the Yard can’t draw.".into()));
        let lit = with_json(GOOD, |json| json["extensionsUsed"] = serde_json::json!(["KHR_lights_punctual"]));
        assert_eq!(check_model(&lit), Err("character.glb uses lights, which a piece may not.".into()));
        let looped = with_json(GOOD, |json| json["nodes"][0]["children"] = serde_json::json!([0]));
        assert!(check_model(&looped).is_err());
        let two = with_json(GOOD, |json| json["scenes"] = serde_json::json!([{ "nodes": [] }, { "nodes": [] }]));
        assert_eq!(check_model(&two), Err("character.glb needs exactly one scene.".into()));
    }

    #[test]
    fn manifests_are_read_as_the_manager_reads_them() {
        assert_eq!(read_manifest(MANIFEST_OK.as_bytes()), Ok("Patchwork".into()));
        assert_eq!(read_manifest(br#"{"format":1,"kind":"character"}"#), Ok(String::new()));
        assert_eq!(read_manifest(br#"{"format":2,"kind":"character"}"#), Err("This piece needs a newer Agent Guild.".into()));
        assert_eq!(read_manifest(br#"{"kind":"character"}"#), Err("This piece’s format is missing.".into()));
        assert_eq!(read_manifest(br#"{"format":1,"kind":"companion"}"#), Err("This is a companion piece, not a character.".into()));
        assert_eq!(read_manifest(br#"{"format":1,"kind":"hat"}"#), Err("This isn’t a character or companion piece.".into()));
        assert_eq!(read_manifest(format!(r#"{{"format":1,"kind":"character","title":"{}"}}"#, "x".repeat(129)).as_bytes()), Err("This piece’s title is too long or unreadable.".into()));
        assert_eq!(read_manifest(b"nope"), Err("This piece’s details can’t be read.".into()));
    }

    #[test]
    fn a_staged_piece_installs_in_one_step_and_is_listed_by_title() {
        let dir = store("install");
        let token = new_id();
        assert_eq!(stage(&dir, &folder("install", MANIFEST_OK, GOOD), &token), Ok("Patchwork".into()));
        assert_eq!(list_characters(&dir), vec![], "a staged piece is not a character yet");
        assert!(model_file(&dir, &format!("/check-{token}"), Some(&token)).is_some());
        assert!(model_file(&dir, &format!("/check-{token}"), Some(&new_id())).is_none(), "only the import being checked is served");
        let id = install(&dir, &token).unwrap();
        assert_eq!(list_characters(&dir), vec![Character { id: id.clone(), title: "Patchwork".into(), readable: true }]);
        assert_eq!(fs::read(model_file(&dir, &format!("/{id}"), None).unwrap()).unwrap(), GOOD);
        assert!(model_file(&dir, &format!("/check-{token}"), Some(&token)).is_none());
    }

    #[test]
    fn a_failed_import_leaves_the_store_as_it_was() {
        let dir = store("failed");
        let token = new_id();
        stage(&dir, &folder("kept", MANIFEST_OK, GOOD), &token).unwrap();
        let kept = install(&dir, &token).unwrap();
        let before = list_characters(&dir);
        for (manifest, model, problem) in [
            (MANIFEST_OK, EXTERNAL, "character.glb refers to files outside itself."),
            (r#"{"format":1,"kind":"companion"}"#, GOOD, "This is a companion piece, not a character."),
        ] {
            assert_eq!(stage(&dir, &folder("failed", manifest, model), &new_id()), Err(problem.into()));
        }
        let token = new_id();
        stage(&dir, &folder("rejected", MANIFEST_OK, GOOD), &token).unwrap();
        discard(&dir, &token);
        assert_eq!(list_characters(&dir), before);
        assert_eq!(fs::read_dir(&*dir).unwrap().count(), 1, "nothing but {kept} is left");
    }

    #[test]
    fn missing_files_and_links_are_refused() {
        let dir = store("missing");
        let source = folder("missing", MANIFEST_OK, GOOD);
        fs::remove_file(source.join(MODEL)).unwrap();
        assert_eq!(stage(&dir, &source, &new_id()), Err("character.glb is missing.".into()));
        fs::create_dir(source.join(MODEL)).unwrap();
        assert_eq!(stage(&dir, &source, &new_id()), Err("character.glb isn’t a plain file.".into()));
        assert_eq!(stage(&dir, &source.join("nowhere"), &new_id()), Err("Choose a piece folder.".into()));
    }

    #[test]
    fn an_untitled_character_keeps_the_name_of_the_folder_it_came_from() {
        let dir = store("untitled");
        let parent = store("sources");
        let ids: Vec<String> = ["Patchwork", "Lantern Keeper"]
            .iter()
            .map(|name| {
                let source = parent.join(name);
                fs::create_dir(&source).unwrap();
                fs::write(source.join(MANIFEST), r#"{"format":1,"kind":"character","title":"  "}"#).unwrap();
                fs::write(source.join(MODEL), GOOD).unwrap();
                let token = new_id();
                assert_eq!(stage(&dir, &source, &token), Ok(name.to_string()));
                install(&dir, &token).unwrap()
            })
            .collect();
        let titles: Vec<String> = list_characters(&dir).into_iter().map(|c| c.title).collect();
        assert_eq!(titles, vec!["Lantern Keeper", "Patchwork"]);
        fs::write(dir.join(&ids[0]).join(MANIFEST), r#"{"format":1,"kind":"character","title":"Renamed"}"#).unwrap();
        assert!(list_characters(&dir).iter().any(|c| c.title == "Patchwork"), "install.json alone names an installed character");
    }

    #[test]
    fn an_interrupted_install_or_removal_is_swept_away() {
        let dir = store("sweep");
        let token = new_id();
        stage(&dir, &folder("sweep", MANIFEST_OK, GOOD), &token).unwrap();
        fs::create_dir(dir.join(format!("{REMOVED}{}", new_id()))).unwrap();
        sweep(&dir);
        assert_eq!(fs::read_dir(&*dir).unwrap().count(), 0);
    }

    #[test]
    fn removal_takes_only_that_character() {
        let dir = store("remove");
        let ids: Vec<String> = (0..2)
            .map(|_| {
                let token = new_id();
                stage(&dir, &folder("remove", MANIFEST_OK, GOOD), &token).unwrap();
                install(&dir, &token).unwrap()
            })
            .collect();
        remove(&dir, &ids[0]).unwrap();
        assert_eq!(list_characters(&dir).iter().map(|c| c.id.clone()).collect::<Vec<_>>(), vec![ids[1].clone()]);
        assert!(model_file(&dir, &ids[0], None).is_none());
        assert!(remove(&dir, "../outside").is_err());
        assert!(remove(&dir, &new_id()).is_err());
    }

    #[test]
    fn a_damaged_character_is_listed_and_can_be_removed() {
        let dir = store("damaged");
        let ids: Vec<String> = (0..3)
            .map(|_| {
                let token = new_id();
                stage(&dir, &folder("damaged", MANIFEST_OK, GOOD), &token).unwrap();
                install(&dir, &token).unwrap()
            })
            .collect();
        fs::write(dir.join(&ids[0]).join(INSTALL), "nope").unwrap();
        fs::remove_file(dir.join(&ids[1]).join(MODEL)).unwrap();
        let listed = list_characters(&dir);
        assert_eq!(listed.len(), 3);
        assert_eq!(listed.iter().filter(|c| !c.readable).map(|c| c.id.clone()).collect::<HashSet<_>>(), HashSet::from([ids[0].clone(), ids[1].clone()]));
        assert!(listed.iter().any(|c| c.id == ids[0] && c.title == "Unreadable character"));
        for id in &ids[..2] {
            remove(&dir, id).unwrap();
        }
        assert_eq!(list_characters(&dir).iter().map(|c| c.id.clone()).collect::<Vec<_>>(), vec![ids[2].clone()]);
    }

    #[test]
    fn removal_never_follows_a_link_out_of_the_store() {
        let dir = store("linked");
        let outside = folder("outside", MANIFEST_OK, GOOD);
        let id = new_id();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&*outside, dir.join(&id));
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&*outside, dir.join(&id));
        if linked.is_ok() {
            assert!(remove(&dir, &id).is_err());
            assert!(outside.join(MODEL).is_file(), "the linked folder's files are untouched");
            assert!(list_characters(&dir).is_empty(), "a linked folder is not offered as a character");
        }
    }

    #[test]
    fn the_protocol_serves_nothing_outside_the_store() {
        let dir = store("protocol");
        let token = new_id();
        stage(&dir, &folder("protocol", MANIFEST_OK, GOOD), &token).unwrap();
        let id = install(&dir, &token).unwrap();
        fs::write(dir.join("secret.txt"), "no").unwrap();
        for path in ["/../secret.txt", "/secret.txt", &format!("/{id}/../secret.txt"), &format!("/{id}/piece.json"), "/check-", "/", "", &format!("/{}", id.to_uppercase())] {
            assert!(model_file(&dir, path, None).is_none(), "{path}");
        }
        let link = dir.join(new_id());
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(dir.join(&id), &link);
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(dir.join(&id), &link);
        if linked.is_ok() {
            assert!(model_file(&dir, link.file_name().unwrap().to_str().unwrap(), None).is_none(), "a linked folder is not served");
        }
    }
}

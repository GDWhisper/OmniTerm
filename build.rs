/// Build script: ensure frontend assets exist before compilation.
///
/// For crates.io: frontend/dist/ is included in the published tarball.
/// For git installs: user must build frontend first.
fn main() {
    let dist = std::path::Path::new("frontend/dist/index.html");
    if !dist.exists() {
        eprintln!(
            "\n  missing frontend assets (frontend/dist/)\n\
               \n  Build the frontend first:\n\
                cd frontend && pnpm install && pnpm build\n\
               \n  Or install a pre-built binary:\n\
                curl -fsSL https://raw.githubusercontent.com/GDWhisper/OmniTerm/main/install.sh | bash\n"
        );
        std::process::exit(1);
    }

    println!("cargo:rerun-if-changed=frontend/dist/");
}

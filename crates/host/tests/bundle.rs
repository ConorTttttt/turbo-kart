//! AiBundle (one tick of every AI slot in one datagram) on real meshes (iroh +
//! moq-net, one process, loopback): followers get the same per-slot snapshots
//! as from per-slot frames, only the current host may bundle, and after a host
//! change an old epoch's bundles are refused. Not an Internet or NAT test.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{ensure, Result};
use bytes::Bytes;
use holochain_moq_clock::LocalClock;
use holochain_moq_host::*;
use holochain_moq_mesh::{MeshConfig, MeshSession, PeerBinding, RaceId};
use holochain_moq_mesh_iroh::{IrohConfig, IrohMeshTransport, Reach};

type Mesh = MeshSession<IrohMeshTransport>;
type Host = HostSession<IrohMeshTransport>;

fn agent(i: usize) -> String {
    format!("uhCAk-bundle-{i:02}")
}

fn fast() -> HostConfig {
    HostConfig {
        heartbeat_interval: Duration::from_millis(100),
        failure_timeout: Duration::from_secs(1),
        succession_timeout: Duration::from_secs(3),
        join_timeout: Duration::from_secs(3),
    }
}

async fn race(n: usize, slots: &[u8]) -> Result<(Vec<Arc<Mesh>>, Vec<Arc<Host>>)> {
    let mut ts = Vec::new();
    for i in 0..n {
        let t = IrohMeshTransport::bind(IrohConfig::new(Reach::DirectOnly), &agent(i)).await?;
        let addr = t.addr(Duration::ZERO).await;
        ts.push((t, addr));
    }
    let bindings: Vec<_> = ts.iter().enumerate().map(|(i, (_, a))| PeerBinding { agent: agent(i), addr: a.clone() }).collect();
    let mut meshes = Vec::new();
    for (i, (t, _)) in ts.into_iter().enumerate() {
        let roster = bindings.iter().filter(|b| b.agent != agent(i)).cloned().collect();
        let (m, _) = MeshSession::start(t, agent(i), RaceId::new("wp5b")?, roster, MeshConfig::default())?;
        meshes.push(Arc::new(m));
    }
    for m in &meshes {
        ensure!(m.wait_for_peers(n - 1, Duration::from_secs(30)).await, "mesh incomplete");
    }
    let members: Vec<String> = (0..n).map(agent).collect();
    let mut hosts = Vec::new();
    for m in &meshes {
        let setup = HostSetup { creator: agent(0), members: members.clone(), ai_slots: slots.to_vec() };
        let (h, _) = HostSession::start(m.clone(), setup, fast(), LocalClock::new())?;
        hosts.push(Arc::new(h));
    }
    tokio::time::sleep(Duration::from_millis(400)).await; // subscriptions settle
    Ok((meshes, hosts))
}

fn payload(slot: u8, tick: u32) -> Bytes {
    let mut v = vec![slot];
    v.extend_from_slice(&tick.to_be_bytes());
    v.extend_from_slice(&[0u8; 37]); // a 42-byte kart state stand-in
    Bytes::from(v)
}

fn tick_of(b: &[u8]) -> u32 {
    u32::from_be_bytes(b[1..5].try_into().unwrap())
}

fn bundle(slots: &[u8], tick: u32) -> Vec<(u8, Bytes)> {
    slots.iter().map(|s| (*s, payload(*s, tick))).collect()
}

async fn until(what: &str, timeout: Duration, mut ok: impl FnMut() -> bool) -> Result<()> {
    let deadline = Instant::now() + timeout;
    while !ok() {
        ensure!(Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_bundle_reaches_followers_as_per_slot_snapshots() -> Result<()> {
    let slots = [0u8, 1, 2, 3, 4, 5];
    let (_m, hs) = race(3, &slots).await?;
    let mut updates = hs[2].ai_updates();
    for tick in 1..=30 {
        hs[0].publish_ai_bundle(bundle(&slots, tick))?;
        tokio::time::sleep(Duration::from_millis(33)).await;
    }
    for h in &hs[1..] {
        until("the last tick of every slot", Duration::from_secs(5), || {
            slots.iter().all(|s| h.latest_ai(*s).is_some_and(|x| tick_of(&x.payload) == 30))
        })
        .await?;
        let st = h.stats();
        assert!(st.ai_bundles_accepted >= 25, "{st:?}");
        assert_eq!(st.ai_frames_accepted, st.ai_bundles_accepted * slots.len() as u64, "{st:?}");
    }
    let host = hs[0].stats();
    assert_eq!((host.ai_bundles_sent, host.ai_frames_sent), (30, 180));
    // The game sees the same per-slot snapshots a per-slot frame gives.
    let mut seen = std::collections::BTreeSet::new();
    while let Ok(s) = updates.try_recv() {
        assert_eq!(s.epoch, HostEpoch(1));
        assert_eq!(s.payload[0], s.slot);
        seen.insert(s.slot);
    }
    assert_eq!(seen.into_iter().collect::<Vec<_>>(), slots.to_vec());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_the_host_bundles_and_only_its_slots() -> Result<()> {
    let slots = [0u8, 1];
    let (_m, hs) = race(2, &slots).await?;
    assert!(matches!(hs[1].publish_ai_bundle(bundle(&slots, 1)), Err(HostError::NotHost { .. })));
    assert!(matches!(hs[0].publish_ai_bundle(bundle(&[0, 7], 1)), Err(HostError::UnknownSlot(7))));
    assert!(matches!(hs[0].publish_ai_bundle(vec![(0, payload(0, 1)), (0, payload(0, 2))]), Err(HostError::Bundle(WireError::BadBundle))));
    assert!(matches!(hs[0].publish_ai_bundle(vec![]), Err(HostError::Bundle(WireError::BadBundle))));
    assert_eq!(hs[0].stats().ai_bundles_sent, 0);
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn after_a_host_change_the_new_host_bundles_and_old_epoch_bundles_are_refused() -> Result<()> {
    let slots = [0u8, 1, 2];
    let (_m, hs) = race(3, &slots).await?;
    hs[0].publish_ai_bundle(bundle(&slots, 1))?;
    until("epoch-1 bundle", Duration::from_secs(5), || hs[2].latest_ai(2).is_some()).await?;
    hs[0].pause_heartbeats(true); // hung host
    let want = Authority { host: agent(1), epoch: HostEpoch(2) };
    until("election of agent 1 at epoch 2", Duration::from_secs(10), || hs.iter().all(|h| h.authority() == want)).await?;
    tokio::time::sleep(Duration::from_millis(300)).await; // followers re-subscribe to the new host
    for tick in 100..110 {
        hs[1].publish_ai_bundle(bundle(&slots, tick))?;
        tokio::time::sleep(Duration::from_millis(33)).await;
    }
    until("epoch-2 bundles from the new host", Duration::from_secs(5), || {
        slots.iter().all(|s| hs[2].latest_ai(*s).is_some_and(|x| x.epoch == HostEpoch(2) && tick_of(&x.payload) == 109))
    })
    .await?;
    // The old host, misbehaving: epoch-1 bundles on its own track and on the new host's.
    let stale = hs[2].stats().stale_rejected;
    for _ in 0..10 {
        hs[0].force_publish_ai_bundle_at(HostEpoch(1), bundle(&slots, 50_000))?;
        hs[1].force_publish_ai_bundle_at(HostEpoch(1), bundle(&slots, 60_000))?;
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    for s in &slots {
        let x = hs[2].latest_ai(*s).unwrap();
        assert_eq!((x.epoch, tick_of(&x.payload)), (HostEpoch(2), 109), "slot {s}");
    }
    assert!(hs[2].stats().stale_rejected - stale >= 10, "{:?}", hs[2].stats());
    Ok(())
}
